/**
 * Busca no texto no estilo do Ctrl+F (versão personalizada):
 * ignora maiúsculas/minúsculas e acentos ("reuniao" encontra "Reunião").
 */

/** Texto "dobrado" (sem acento, minúsculo) e o mapa de cada caractere para a posição original. */
function fold(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const base = text[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (let k = 0; k < base.length; k++) {
      folded += base[k];
      map.push(i);
    }
  }
  map.push(text.length);
  return { folded, map };
}

export function foldQuery(query: string): string {
  return query.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Todas as ocorrências de `query` em `text`, como [início, fim) no texto original. */
export function findAll(text: string, query: string): Array<[number, number]> {
  const q = foldQuery(query);
  if (!q || !text) return [];
  const { folded, map } = fold(text);
  const out: Array<[number, number]> = [];
  let from = 0;
  while (from <= folded.length - q.length) {
    const idx = folded.indexOf(q, from);
    if (idx < 0) break;
    const start = map[idx];
    const end = map[idx + q.length - 1] + 1;
    out.push([start, end]);
    from = idx + q.length;
  }
  return out;
}
