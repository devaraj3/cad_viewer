// src/fileStore.ts
// Simple module-level store to pass a File from the landing page to the viewer.
// Not React state - intentionally a plain module variable so it survives navigation.

let _pendingFile: File | null = null;

export function setPendingFile(file: File): void {
  _pendingFile = file;
}

export function consumePendingFile(): File | null {
  const f = _pendingFile;
  _pendingFile = null;
  return f;
}
