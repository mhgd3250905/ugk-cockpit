// The note contains both the original explanation and its handling instructions.
// Never fall back to copying only the visible body or report a failed write as success.
export async function copyNoteText(text, {
  clipboard = globalThis.navigator?.clipboard,
  document = globalThis.document,
} = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('缺少完整说明，请刷新后重试。');
  }
  try {
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Some browser contexts reject the asynchronous API but allow selection copy.
  }
  if (!document?.body || !document.execCommand) return false;

  const active = document.activeElement;
  const inputSelection = typeof active?.selectionStart === 'number'
    ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  // Keep selection in the viewport so the temporary field cannot scroll the page.
  textarea.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.append(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    textarea.remove();
    active?.focus({ preventScroll: true });
    if (inputSelection) active.setSelectionRange(...inputSelection);
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
