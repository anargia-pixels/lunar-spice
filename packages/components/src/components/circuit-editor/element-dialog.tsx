import { Button } from "@lunar-spice/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@lunar-spice/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@lunar-spice/components/ui/field";
import { Input } from "@lunar-spice/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@lunar-spice/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lunar-spice/components/ui/select";
import { Switch } from "@lunar-spice/components/ui/switch";
import { Textarea } from "@lunar-spice/components/ui/textarea";
import { cloneElement } from "@lunar-spice/simulator/circuit";
import {
  type CircuitElement,
  type EditField,
  rangeError,
} from "@lunar-spice/simulator/element";
import { formatEditValue, parseSi } from "@lunar-spice/simulator/units";
import { useId, useState } from "react";

/** A value with its unit, typed with SI prefixes such as 4.7k or 10u. */
function NumberField({
  field,
  draft,
  error,
  onDraftChange,
}: {
  field: Extract<EditField, { kind: "number" }>;
  draft: string;
  error: string | null;
  onDraftChange: (text: string) => void;
}) {
  const id = useId();

  return (
    <Field data-invalid={error !== null}>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          value={draft}
          aria-invalid={error !== null}
          spellCheck={false}
          onChange={(event) => onDraftChange(event.target.value)}
          onFocus={(event) => event.target.select()}
        />
        {field.unit && (
          <InputGroupAddon align="inline-end">
            <InputGroupText>{field.unit}</InputGroupText>
          </InputGroupAddon>
        )}
      </InputGroup>
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        field.hint && <FieldDescription>{field.hint}</FieldDescription>
      )}
    </Field>
  );
}

/** Applies a pasted SPICE .model card, reporting why one could not be used. */
function SpiceField({
  field,
  onApplied,
}: {
  field: Extract<EditField, { kind: "spice" }>;
  onApplied: () => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  return (
    <Field data-invalid={message !== null}>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <Textarea
        id={id}
        value={text}
        rows={3}
        spellCheck={false}
        placeholder=".model NAME TYPE(IS=… N=… …)"
        onChange={(event) => setText(event.target.value)}
      />
      {message ? (
        <FieldError>{message}</FieldError>
      ) : (
        field.hint && <FieldDescription>{field.hint}</FieldDescription>
      )}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={!text.trim()}
        onClick={() => {
          const error = field.set(text);

          setMessage(error);

          if (!error) {
            setText("");
            onApplied();
          }
        }}
      >
        Apply model
      </Button>
    </Field>
  );
}

/** A labeled dropdown for choice and preset fields. */
function ChoiceField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();

  const items = Object.fromEntries(
    options.map((option) => [option.value, option.label]),
  );

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={items}
        value={value}
        onValueChange={(next) => {
          if (next !== null) {
            onChange(next);
          }
        }}
      >
        <SelectTrigger id={id} className="w-full justify-between">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * Edits one element's values on a copy, then hands the copy back on save. Presets and
 * pasted SPICE models rewrite many values at once, so the fields are read from the copy
 * again after every change.
 */
function ElementForm({
  element,
  onSave,
}: {
  element: CircuitElement;
  onSave: (replacement: CircuitElement) => void;
}) {
  const [draft] = useState(() => cloneElement(element));
  const [, setVersion] = useState(0); // re-renders after the copy changes
  const [texts, setTexts] = useState(new Map<string, string>());
  const [errors, setErrors] = useState(new Map<string, string>());
  const switchId = useId();

  const fields = draft.dialogFields();

  /** Re-reads every field from the copy after a change to many values. */
  const refresh = () => {
    setTexts(new Map());
    setErrors(new Map());
    setVersion((version) => version + 1);
  };

  /** Keeps the typed text and its error; sets the value only when it is valid. */
  const updateNumber = (
    field: Extract<EditField, { kind: "number" }>,
    text: string,
  ) => {
    const value = parseSi(text);

    const error =
      value === null
        ? "Enter a number, such as 4.7k."
        : rangeError(value, field.range);

    setTexts((current) => new Map(current).set(field.key, text));
    setErrors((current) => {
      const next = new Map(current);

      if (error) {
        next.set(field.key, error);
      } else {
        next.delete(field.key);
      }

      return next;
    });

    if (value !== null && !error) {
      field.set(value);
    }
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();

        if (errors.size === 0) {
          onSave(draft);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>{element.title()}</DialogTitle>
        <DialogDescription>
          Type values with SI prefixes, such as 4.7k, 10u or 2.2meg.
        </DialogDescription>
      </DialogHeader>
      <div className="-mx-1 grid max-h-96 gap-4 overflow-y-auto px-1">
        {fields.length === 0 && (
          <p className="text-muted-foreground text-sm">
            This part has no values to edit.
          </p>
        )}
        {fields.map((field) => {
          switch (field.kind) {
            case "number":
              return (
                <NumberField
                  key={field.key}
                  field={field}
                  draft={texts.get(field.key) ?? formatEditValue(field.value)}
                  error={errors.get(field.key) ?? null}
                  onDraftChange={(text) => updateNumber(field, text)}
                />
              );
            case "choice":
              return (
                <ChoiceField
                  key={field.key}
                  label={field.label}
                  value={field.value}
                  options={field.options}
                  onChange={(value) => {
                    field.set(value);
                    refresh();
                  }}
                />
              );
            case "preset":
              return (
                <ChoiceField
                  key={field.key}
                  label={field.label}
                  value={field.options.includes(field.value) ? field.value : ""}
                  options={[
                    ...(field.options.includes(field.value)
                      ? []
                      : [{ value: "", label: `${field.value} (custom)` }]),
                    ...field.options.map((name) => ({
                      value: name,
                      label: name,
                    })),
                  ]}
                  onChange={(value) => {
                    if (value) {
                      field.set(value);
                      refresh();
                    }
                  }}
                />
              );
            case "boolean":
              return (
                <Field key={field.key} orientation="horizontal">
                  <Switch
                    id={`${switchId}-${field.key}`}
                    checked={field.value}
                    onCheckedChange={(checked) => {
                      field.set(checked);
                      refresh();
                    }}
                  />
                  <FieldLabel htmlFor={`${switchId}-${field.key}`}>
                    {field.label}
                  </FieldLabel>
                </Field>
              );
            case "text":
              return (
                <Field key={field.key}>
                  <FieldLabel htmlFor={`${switchId}-${field.key}`}>
                    {field.label}
                  </FieldLabel>
                  <Input
                    id={`${switchId}-${field.key}`}
                    value={texts.get(field.key) ?? field.value}
                    onChange={(event) => {
                      setTexts((current) =>
                        new Map(current).set(field.key, event.target.value),
                      );
                      field.set(event.target.value);
                    }}
                  />
                </Field>
              );
            case "spice":
              return (
                <SpiceField key={field.key} field={field} onApplied={refresh} />
              );
          }
        })}
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={errors.size > 0}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The properties dialog for one element; open while `element` is set. */
export function ElementDialog({
  element,
  onClose,
  onSave,
}: {
  element: CircuitElement | null;
  onClose: () => void;
  onSave: (original: CircuitElement, replacement: CircuitElement) => void;
}) {
  return (
    <Dialog
      open={element !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        {element && (
          <ElementForm
            key={element.id}
            element={element}
            onSave={(replacement) => {
              onSave(element, replacement);
              onClose();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
