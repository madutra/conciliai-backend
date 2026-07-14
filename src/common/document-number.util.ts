// Extração de "tokens de documento" a partir de campos livres (Dcto. do
// banco, DOCUMENTO do financeiro, HISTORICO do razão).
//
// Cada fonte carrega o número do título/NF num formato diferente:
//   banco:      "NFE018643 CURINGA DAS BORRACHAS" (embutido na descrição)
//   financeiro: "0104 1   000018643    NF"
//   razão:      "BX.PAG.-1  /000018643 CURINGA DAS BOR"
// Normalizando (sequências numéricas, zeros à esquerda fora) os três viram
// o token "18643" — que é a chave de match mais forte que existe entre as
// pontas, bem mais confiável que só data+valor.

// Filtro de ruído: "0104" (filial), "0526" (competência) e contadores tipo
// "00000005" não podem virar chave de match. Um token vale se:
//   - tem 4+ dígitos significativos ("18643", "1643256"), ou
//   - é documento zero-padded do Protheus ("000000588" → "588"): 6+ dígitos
//     crus com 2+ significativos
const MIN_TOKEN_DIGITS = 4;
const MIN_PADDED_RAW_DIGITS = 6;
const MIN_PADDED_SIGNIFICANT = 2;
const MAX_TOKENS = 8;

export function extractDocTokens(...sources: (string | null | undefined)[]): string | undefined {
  const tokens = new Set<string>();

  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(/\d{3,}/g)) {
      const raw = match[0];
      const normalized = raw.replace(/^0+/, '');
      const isPaddedDoc =
        raw.length >= MIN_PADDED_RAW_DIGITS && normalized.length >= MIN_PADDED_SIGNIFICANT;
      if (normalized.length >= MIN_TOKEN_DIGITS || isPaddedDoc) tokens.add(normalized);
      if (tokens.size >= MAX_TOKENS) break;
    }
  }

  return tokens.size ? [...tokens].join(' ') : undefined;
}

// Compara dois campos documentNumber (listas de tokens separadas por espaço).
// Considera "mesmo documento" se houver pelo menos um token em comum que não
// esteja na lista de exclusão (tokens "de conta", frequentes demais pra
// identificar um documento — ex.: o número da carteira de cobrança que
// aparece em dezenas de tarifas).
export function docTokensOverlap(
  a?: string | null,
  b?: string | null,
  exclude?: Set<string>,
): boolean {
  if (!a || !b) return false;
  const setA = new Set(a.split(' '));
  return b.split(' ').some((token) => setA.has(token) && !exclude?.has(token));
}

// Tokens que se repetem demais no lote não identificam documento nenhum:
// são código da carteira, da conta, do convênio. Acima do teto, viram ruído.
export function buildCommonTokenSet(
  documentNumbers: (string | null | undefined)[],
  maxOccurrences = 8,
): Set<string> {
  const counts = new Map<string, number>();
  for (const docField of documentNumbers) {
    if (!docField) continue;
    for (const token of new Set(docField.split(' '))) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const common = new Set<string>();
  for (const [token, count] of counts) {
    if (count > maxOccurrences) common.add(token);
  }
  return common;
}
