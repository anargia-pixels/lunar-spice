import {
  Delete02Icon,
  Mic01Icon,
  StopIcon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@lunar-spice/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@lunar-spice/components/ui/field";
import { Input } from "@lunar-spice/components/ui/input";
import type { EditField } from "@lunar-spice/simulator/element";
import { useEffect, useId, useRef, useState } from "react";

import {
  ClipRecorder,
  clipDuration,
  clipFromFile,
  decodeClip,
  MAX_RECORDING_SECONDS,
} from "./sound-clips";

/** How often the recording time ticks, in milliseconds. */
const TICK_MS = 200;

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

/** Seconds as m:ss. */
function formatSeconds(seconds: number) {
  const whole = Math.floor(seconds);

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The clip's name and length, the length once it has been decoded. */
function ClipSummary({
  clip,
}: {
  clip: NonNullable<Extract<EditField, { kind: "clip" }>["value"]>;
}) {
  const [decoded, setDecoded] = useState<{
    clip: typeof clip;
    duration: number;
  } | null>(null);

  // A length decoded for an earlier clip is not shown.
  const duration = decoded?.clip === clip ? decoded.duration : null;

  useEffect(() => {
    let isCurrent = true;

    decodeClip(clip)
      .then((samples) => {
        if (isCurrent) {
          setDecoded({ clip, duration: clipDuration(samples) });
        }
      })
      .catch(() => {
        // The run reports clips it cannot play; the name alone is shown here.
      });

    return () => {
      isCurrent = false;
    };
  }, [clip]);

  return (
    <span className="min-w-0 truncate text-sm">
      {clip.name}
      {duration !== null && (
        <span className="text-muted-foreground tabular-nums">
          {" "}
          · {formatSeconds(duration)}
        </span>
      )}
    </span>
  );
}

/**
 * A microphone's sound clip: records one from the computer's microphone or takes an
 * audio file, and shows the one it has.
 */
export function SoundClipField({
  field,
  onChange,
}: {
  field: Extract<EditField, { kind: "clip" }>;
  onChange: () => void;
}) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<ClipRecorder | null>(null);
  /** When the recording began, by `performance.now()`. */
  const recordingStart = useRef(0);
  /** Stops the recording at the longest a clip may be. */
  const recordingLimit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [recordedSeconds, setRecordedSeconds] = useState<number | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isRecording = recordedSeconds !== null;

  const finishRecording = async () => {
    const current = recorder.current;

    if (recordingLimit.current !== null) {
      clearTimeout(recordingLimit.current);
      recordingLimit.current = null;
    }

    recorder.current = null;
    setRecordedSeconds(null);

    if (!current) {
      return;
    }

    setIsBusy(true);

    try {
      field.set(await current.stop());
      setError(null);
      onChange();
    } catch (cause) {
      setError(errorMessage(cause, "The recording could not be kept."));
    } finally {
      setIsBusy(false);
    }
  };

  const startRecording = async () => {
    const next = new ClipRecorder();

    setIsBusy(true);

    try {
      await next.start();
      recorder.current = next;
      recordingStart.current = performance.now();
      recordingLimit.current = setTimeout(
        () => void finishRecording(),
        MAX_RECORDING_SECONDS * 1000,
      );
      setRecordedSeconds(0);
      setError(null);
    } catch (cause) {
      setError(
        `The microphone is unavailable: ${errorMessage(cause, "it was refused.")}`,
      );
    } finally {
      setIsBusy(false);
    }
  };

  // Counts the recording's time.
  useEffect(() => {
    if (!isRecording) {
      return;
    }

    const timer = setInterval(() => {
      setRecordedSeconds((performance.now() - recordingStart.current) / 1000);
    }, TICK_MS);

    return () => clearInterval(timer);
  }, [isRecording]);

  // Closing the dialog mid-recording drops it and frees the microphone.
  useEffect(
    () => () => {
      if (recordingLimit.current !== null) {
        clearTimeout(recordingLimit.current);
      }

      recorder.current?.cancel();
    },
    [],
  );

  const pickFile = async (file: File) => {
    setIsBusy(true);

    try {
      field.set(await clipFromFile(file, file.name));
      setError(null);
      onChange();
    } catch (cause) {
      setError(errorMessage(cause, `${file.name} could not be read.`));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <Field aria-labelledby={id} data-invalid={error !== null}>
      <FieldLabel id={id}>{field.label}</FieldLabel>
      <div className="flex min-h-8 items-center gap-2">
        {isRecording ? (
          <span className="text-sm tabular-nums">
            Recording… {formatSeconds(recordedSeconds)} of{" "}
            {formatSeconds(MAX_RECORDING_SECONDS)}
          </span>
        ) : field.value ? (
          <ClipSummary clip={field.value} />
        ) : (
          <span className="text-muted-foreground text-sm">No clip yet.</span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {isRecording ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void finishRecording()}
          >
            <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
            Stop
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={isBusy}
            onClick={() => void startRecording()}
          >
            <HugeiconsIcon icon={Mic01Icon} strokeWidth={2} />
            Record
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={isBusy || isRecording}
          onClick={() => fileInput.current?.click()}
        >
          <HugeiconsIcon icon={Upload01Icon} strokeWidth={2} />
          Open audio file…
        </Button>
        {field.value && !isRecording && (
          <Button
            variant="ghost"
            size="sm"
            disabled={isBusy}
            onClick={() => {
              field.set(null);
              setError(null);
              onChange();
            }}
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            Remove
          </Button>
        )}
        <Input
          ref={fileInput}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];

            // Picking the same file again still fires a change.
            event.target.value = "";

            if (file) {
              void pickFile(file);
            }
          }}
        />
      </div>
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        field.hint && <FieldDescription>{field.hint}</FieldDescription>
      )}
    </Field>
  );
}
