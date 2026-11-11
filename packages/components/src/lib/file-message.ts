import { createElement } from "react";
import type { ReactNode } from "react";

/**
 * Quoted file names in a message: straight quotes, as Node's file errors write them, or
 * curly ones, as the app's own messages do.
 */
const QUOTED = /"((?:\\.|[^"\\])*)"|'([^'\n]*)'|“([^”\n]*)”/gu;

/** Renders the quoted file names in `message` as code, without interpreting HTML. */
export function formatFileMessage(message: string) {
  const parts: ReactNode[] = [];
  let offset = 0;

  for (const match of message.matchAll(QUOTED)) {
    const [quoted, escaped, single, curly] = match;
    const name = escaped?.replace(/\\(.)/gu, "$1") ?? single ?? curly ?? "";

    if (/\.[a-z\d]+$/iu.test(name)) {
      parts.push(
        message.slice(offset, match.index),
        createElement("code", { key: match.index }, name),
      );
      offset = match.index + quoted.length;
    }
  }

  parts.push(message.slice(offset));

  return parts;
}
