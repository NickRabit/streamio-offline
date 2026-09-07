import { t } from "./i18n";

/** navigator.clipboard only exists in a secure context. The server on a NAS runs over
 * plain HTTP, where the object is simply absent and the call throws, so we fall back to
 * the old text-selection trick, which works there too. */
export async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return; }
    catch { /* fall through to the path below */ }
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // Off screen, but not display:none -- a hidden element cannot be selected.
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
  document.body.appendChild(area);
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount ? selection.getRangeAt(0) : undefined;
  area.select();
  area.setSelectionRange(0, text.length);

  let copied = false;
  try { copied = document.execCommand("copy"); } catch { copied = false; }
  area.remove();
  if (previous && selection) { selection.removeAllRanges(); selection.addRange(previous); }

  if (!copied) throw new Error(t("api.copyRefused"));
}
