export interface PluralForms { one: string; few?: string; other: string }

/** Czech counts in three: one file, two files, five of them. English needs two,
 *  so `few` stays optional and falls back to `other`. */
export function pluralForm(locale: string, count: number, forms: PluralForms): string {
  if (count === 1) return forms.one;
  if (locale === "cs" && count >= 2 && count <= 4) return forms.few ?? forms.other;
  return forms.other;
}
