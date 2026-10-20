/**
 * Reliable clipboard copy function with fallback for non-HTTPS and restricted contexts.
 */
export async function copyToClipboard(text: string | null | undefined): Promise<boolean> {
  if (!text) return false;

  // 1. Try modern navigator.clipboard API if available and secure
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback to execCommand below
    }
  }

  // 2. Fallback using temporary textarea element and document.execCommand('copy')
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    // Keep offscreen and invisible
    textArea.style.position = 'fixed';
    textArea.style.top = '-9999px';
    textArea.style.left = '-9999px';
    textArea.setAttribute('readonly', '');
    document.body.appendChild(textArea);
    textArea.select();
    textArea.setSelectionRange(0, 99999); // Mobile devices
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    return successful;
  } catch {
    return false;
  }
}
