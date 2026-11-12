/**
 * Exports a circuit as a download named `name`, where the browser keeps downloads; a
 * browser cannot ask where to write it. Returns the name.
 */
export async function downloadCircuitFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");

  link.href = url;
  link.download = name;
  link.click();
  // The download has its own copy once the click is handled.
  setTimeout(() => URL.revokeObjectURL(url));

  return name;
}
