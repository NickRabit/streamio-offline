/** Schránka přes navigator.clipboard je dostupná jen v zabezpečeném kontextu.
 * Server na NASu běží po HTTP, takže tam objekt vůbec neexistuje a volání spadne;
 * padáme proto zpět na staré označení textu, které funguje i tam. */
export async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); return; }
    catch { /* zkusíme náhradní cestu níž */ }
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // Mimo obraz, ale ne display:none -- skrytý prvek nejde označit.
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

  if (!copied) throw new Error("Prohlížeč kopírování nepovolil. Označte text a zkopírujte ho ručně.");
}
