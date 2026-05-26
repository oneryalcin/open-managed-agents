export function sseEventFrame(event: Record<string, unknown>): string {
  const id = String(event.id ?? "");
  const type = String(event.type ?? "message");
  const data = JSON.stringify(event);
  return `id: ${id}\nevent: ${type}\ndata: ${data}\n\n`;
}

