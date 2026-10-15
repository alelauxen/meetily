/**
 * Exportação do resumo/ata para PDF e Word (versão personalizada).
 *
 * - PDF: abre a janela de impressão do sistema com a ata formatada
 *   (no Windows, escolher "Microsoft Print to PDF"). As margens ficam no
 *   próprio documento, então o navegador não imprime endereço/data no topo.
 * - Word: gera um .docx de verdade, com cabeçalho do Word (logo + empresa)
 *   repetido em todas as páginas, e grava na pasta Downloads.
 */

import { writeFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { downloadDir, join } from '@tauri-apps/api/path';
import {
  AlignmentType,
  BorderStyle,
  Document,
  Header,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';

export interface Signatory {
  name: string;
  cpf: string;
  role?: string;
}

/** Logo salvo no app (sempre PNG, já redimensionado). */
export interface LogoImage {
  id: string;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
}

export interface ExportOptions {
  title: string;
  organization?: string;
  logo?: LogoImage | null;
  signatories?: Signatory[];
  /** Se definido, substitui a lista da seção "Participantes" do resumo. */
  participants?: string[];
}

// ---------------------------------------------------------------------------
// Participantes: localizar e substituir a seção no Markdown do resumo
// ---------------------------------------------------------------------------

const PARTICIPANTS_RE = /participantes|participants|presentes|attendees/i;

function headingText(line: string): string | null {
  const t = line.trim();
  let m = t.match(/^#{1,6}\s+(.*?)\s*#*$/);
  if (m) return m[1].replace(/\*\*/g, '').trim();
  m = t.match(/^\*\*([^*]+)\*\*:?$/);
  if (m) return m[1].trim();
  return null;
}

/** Retorna [início, fim) das linhas de conteúdo da seção de participantes, ou null. */
function findParticipantsSection(lines: string[]): { heading: number; start: number; end: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const h = headingText(lines[i]);
    if (h !== null && PARTICIPANTS_RE.test(h)) {
      let end = i + 1;
      while (end < lines.length && headingText(lines[end]) === null) end++;
      return { heading: i, start: i + 1, end };
    }
  }
  return null;
}

/** Extrai os nomes de participantes do resumo (vazio se não identificados). */
export function extractParticipants(markdown: string): string[] {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const sec = findParticipantsSection(lines);
  if (!sec) return [];
  const names: string[] = [];
  for (const line of lines.slice(sec.start, sec.end)) {
    const t = line.trim();
    if (!t) continue;
    if (/não identificad|nao identificad|not identified/i.test(t)) continue;
    const m = t.match(/^([-*+]|\d+[.)])\s+(.*)$/);
    const name = (m ? m[2] : t).replace(/\*\*/g, '').trim();
    if (name) names.push(name);
  }
  return names;
}

/** Substitui (ou cria) a seção de participantes com a lista informada. */
export function replaceParticipants(markdown: string, names: string[]): string {
  const clean = names.map(n => n.trim()).filter(Boolean);
  const lines = markdown.replace(/\r/g, '').split('\n');
  const body = clean.length
    ? clean.map(n => `- ${n}`)
    : ['- Participantes não identificados na gravação'];
  const sec = findParticipantsSection(lines);
  if (sec) {
    return [...lines.slice(0, sec.start), '', ...body, '', ...lines.slice(sec.end)].join('\n');
  }
  if (!clean.length) return markdown;
  // Sem seção: insere logo após o título (ou no início)
  const titleIdx = lines.findIndex(l => /^#\s+/.test(l.trim()));
  const at = titleIdx >= 0 ? titleIdx + 1 : 0;
  return [...lines.slice(0, at), '', '## Participantes', '', ...body, '', ...lines.slice(at)].join('\n');
}

/** Formata CPF como XXX.XXX.XXX-XX enquanto o usuário digita. */
export function formatCpf(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Markdown -> blocos (usado tanto pelo PDF quanto pelo Word)
// ---------------------------------------------------------------------------

export interface InlineRun { text: string; bold?: boolean; italic?: boolean; }

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; runs: InlineRun[] }
  | { type: 'paragraph'; runs: InlineRun[] }
  | { type: 'list'; ordered: boolean; items: InlineRun[][] }
  | { type: 'table'; head: InlineRun[][]; rows: InlineRun[][][] };

/** Divide o texto em trechos com negrito/itálico. */
export function parseInline(s: string): InlineRun[] {
  const text = s
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const runs: InlineRun[] = [];
  const re = /\*\*(.+?)\*\*|__(.+?)__|\*(?!\s)(.+?)\*(?!\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined || m[2] !== undefined) runs.push({ text: (m[1] ?? m[2]) as string, bold: true });
    else runs.push({ text: m[3], italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text: '' }];
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function isSep(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r/g, '').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  let i = 0;
  const flush = () => {
    if (para.length) {
      out.push({ type: 'paragraph', runs: parseInline(para.join(' ')) });
      para = [];
    }
  };

  while (i < lines.length) {
    const t = lines[i].trim();
    let m: RegExpMatchArray | null;
    if (!t) { flush(); i++; continue; }

    if ((m = t.match(/^(#{1,6})\s+(.*)$/))) {
      flush();
      const level = Math.min(m[1].length, 3) as 1 | 2 | 3;
      out.push({ type: 'heading', level, runs: parseInline(m[2].replace(/#+$/, '').replace(/\*\*/g, '').trim()) });
      i++; continue;
    }
    if ((m = t.match(/^\*\*([^*]+)\*\*:?$/))) {
      flush();
      out.push({ type: 'heading', level: 2, runs: [{ text: m[1].trim() }] });
      i++; continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); i++; continue; }

    if (t.startsWith('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      flush();
      const head = cells(t);
      i += 2;
      const rows: InlineRun[][][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const r = cells(lines[i]);
        if (!isSep(lines[i]) && r.some(c => c)) rows.push(head.map((_, k) => parseInline(r[k] || '')));
        i++;
      }
      out.push({ type: 'table', head: head.map(parseInline), rows });
      continue;
    }

    if (/^([-*+]|\d+[.)])\s+/.test(t)) {
      flush();
      const ordered = /^\d/.test(t);
      const items: InlineRun[][] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const txt = lines[i].trim().replace(/^([-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s*/, '');
        items.push(parseInline(txt));
        i++;
      }
      out.push({ type: 'list', ordered, items });
      continue;
    }

    para.push(t);
    i++;
  }
  flush();
  return out;
}

/** Monta os blocos finais da ata: participantes editados + título garantido. */
export function buildBlocks(markdown: string, opts: ExportOptions): Block[] {
  const md = opts.participants ? replaceParticipants(markdown, opts.participants) : markdown;
  const blocks = parseBlocks(md);
  // Usa o título gerado pela IA; se não houver, usa o título da reunião.
  if (!(blocks[0] && blocks[0].type === 'heading' && blocks[0].level === 1)) {
    blocks.unshift({ type: 'heading', level: 1, runs: [{ text: opts.title || 'Ata de Reunião' }] });
  }
  return blocks;
}

function signatoriesOf(opts: ExportOptions): Signatory[] {
  return (opts.signatories || []).filter(s => s.name.trim());
}

// ---------------------------------------------------------------------------
// HTML (PDF)
// ---------------------------------------------------------------------------

function runsHtml(runs: InlineRun[]): string {
  return runs.map(r => {
    let h = esc(r.text);
    if (r.italic) h = `<em>${h}</em>`;
    if (r.bold) h = `<strong>${h}</strong>`;
    return h;
  }).join('');
}

export function blocksToHtml(blocks: Block[]): string {
  return blocks.map(b => {
    switch (b.type) {
      case 'heading': return `<h${b.level}>${runsHtml(b.runs)}</h${b.level}>`;
      case 'paragraph': return `<p>${runsHtml(b.runs)}</p>`;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        return `<${tag}>${b.items.map(it => `<li>${runsHtml(it)}</li>`).join('')}</${tag}>`;
      }
      case 'table':
        return '<table class="dados"><thead><tr>' + b.head.map(c => `<th>${runsHtml(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          b.rows.map(r => '<tr>' + r.map(c => `<td>${runsHtml(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>';
    }
  }).join('\n');
}

/** Tamanho de exibição do logo no cabeçalho (em pontos). */
function logoSize(logo: LogoImage, maxH = 54, maxW = 140): { w: number; h: number } {
  const ratio = logo.width / logo.height || 1;
  let h = maxH;
  let w = h * ratio;
  if (w > maxW) { w = maxW; h = w / ratio; }
  return { w: Math.round(w), h: Math.round(h) };
}

function headerHtml(opts: ExportOptions): string {
  const org = (opts.organization || '').trim();
  const logo = opts.logo;
  if (!org && !logo) return '';
  const img = logo
    ? (() => { const s = logoSize(logo); return `<img src="${logo.dataUrl}" style="width:${s.w}pt;height:${s.h}pt" alt="">`; })()
    : '';
  return `<div class="cab"><table><tr>
    <td class="cab-l">${img}</td>
    <td class="cab-c">${org ? `<div class="org">${esc(org)}</div>` : ''}</td>
    <td class="cab-r"></td>
  </tr></table></div>`;
}

function signaturesHtml(opts: ExportOptions): string {
  const sigs = signatoriesOf(opts);
  if (!sigs.length) return '';
  const cell = (s: Signatory) =>
    '<td><div class="linha">' +
    `<div class="nome">${esc(s.name.trim())}</div>` +
    (s.cpf.trim() ? `<div>CPF: ${esc(s.cpf.trim())}</div>` : '') +
    (s.role && s.role.trim() ? `<div>${esc(s.role.trim())}</div>` : '') +
    '</div></td>';
  let rows = '';
  for (let i = 0; i < sigs.length; i += 2) {
    rows += '<tr>' + cell(sigs[i]) + (sigs[i + 1] ? cell(sigs[i + 1]) : '<td></td>') + '</tr>';
  }
  return `<table class="assin">${rows}</table>`;
}

const DOC_CSS = `
  /* Margem zero na página: assim o navegador não imprime endereço, título e data.
     As margens reais ficam no próprio documento (padding e linhas repetidas). */
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "Times New Roman", Times, serif; font-size: 12pt; line-height: 1.5; color: #000;
         padding: 0 2cm 0 3cm; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  table.pagina { width: 100%; border-collapse: collapse; }
  table.pagina > thead > tr > td, table.pagina > tfoot > tr > td, table.pagina > tbody > tr > td { padding: 0; border: 0; }
  .topo { height: 1.5cm; }
  .rodape { height: 2cm; }
  .cab { padding-bottom: 6px; margin-bottom: 14px; border-bottom: 2px solid #000; }
  .cab table { width: 100%; border-collapse: collapse; }
  .cab td { border: 0; padding: 0; vertical-align: middle; }
  .cab-l, .cab-r { width: 25%; }
  .cab-c { width: 50%; text-align: center; }
  .cab .org { font-weight: bold; text-transform: uppercase; font-size: 13pt; }
  h1 { font-size: 15pt; text-align: center; text-transform: uppercase; margin: 6px 0 18px; }
  h2 { font-size: 12.5pt; text-transform: uppercase; border-bottom: 1px solid #000; padding-bottom: 2px; margin: 18px 0 8px; page-break-after: avoid; }
  h3 { font-size: 12pt; margin: 14px 0 6px; page-break-after: avoid; }
  p { text-align: justify; margin: 0 0 8px; }
  ul, ol { margin: 0 0 8px; padding-left: 24px; }
  table.dados { border-collapse: collapse; width: 100%; margin: 6px 0 10px; font-size: 11pt; }
  table.dados th, table.dados td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; text-align: left; }
  table.dados th { background: #e6e6e6; }
  table.dados tr { page-break-inside: avoid; }
  table.assin { margin-top: 36px; width: 100%; border-collapse: collapse; }
  table.assin td { width: 50%; padding: 48px 16px 0; text-align: center; vertical-align: top; font-size: 11pt; page-break-inside: avoid; }
  table.assin .linha { border-top: 1px solid #000; padding-top: 4px; }
  table.assin .nome { font-weight: bold; }
`;

/** Documento HTML completo para impressão em PDF (cabeçalho repetido em cada página). */
export function buildPrintHtml(markdown: string, opts: ExportOptions): string {
  const body = blocksToHtml(buildBlocks(markdown, opts)) + signaturesHtml(opts);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(opts.title || 'Ata')}</title>
<style>${DOC_CSS}</style></head><body>
<table class="pagina">
  <thead><tr><td><div class="topo"></div>${headerHtml(opts)}</td></tr></thead>
  <tfoot><tr><td><div class="rodape"></div></td></tr></tfoot>
  <tbody><tr><td>${body}</td></tr></tbody>
</table>
</body></html>`;
}

export function safeFileName(title: string): string {
  return (title || 'Ata de Reuniao').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Ata de Reuniao';
}

/** Abre a janela de impressão com a ata formatada (para salvar em PDF). */
export function printAsPdf(markdown: string, opts: ExportOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) {
      iframe.remove();
      reject(new Error('Não foi possível preparar a impressão'));
      return;
    }
    doc.open();
    doc.write(buildPrintHtml(markdown, opts));
    doc.close();

    // Espera o logo carregar antes de imprimir
    const imgs = Array.from(doc.images);
    const ready = Promise.all(imgs.map(img => img.complete ? Promise.resolve() :
      new Promise<void>(r => { img.onload = () => r(); img.onerror = () => r(); })));

    ready.then(() => setTimeout(() => {
      try {
        win.focus();
        win.print();
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        setTimeout(() => iframe.remove(), 2000);
      }
    }, 200));
  });
}

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------

const FONT = 'Times New Roman';
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = {
  top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
  insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
};
const LINE = { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 };
const cmToTwip = (cm: number) => Math.round((cm / 2.54) * 1440);
/** Largura útil da página A4 com margens de 3 cm e 2 cm (16 cm). */
const TEXT_WIDTH = cmToTwip(16);

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.split(',')[1] || '';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function textRuns(runs: InlineRun[], extra: { size?: number; bold?: boolean; allCaps?: boolean } = {}): TextRun[] {
  return runs.map(r => new TextRun({
    text: r.text,
    bold: extra.bold || r.bold,
    italics: r.italic,
    size: extra.size,
    allCaps: extra.allCaps,
    font: FONT,
  }));
}

function docxHeader(opts: ExportOptions): Header | undefined {
  const org = (opts.organization || '').trim();
  const logo = opts.logo;
  if (!org && !logo) return undefined;

  const logoPara = new Paragraph({
    children: logo
      ? [(() => {
          const s = logoSize(logo);
          // docx usa pixels a 96 dpi: 1pt = 96/72 px
          return new ImageRun({
            type: 'png',
            data: dataUrlToBytes(logo.dataUrl),
            transformation: { width: Math.round(s.w * 96 / 72), height: Math.round(s.h * 96 / 72) },
          });
        })()]
      : [],
  });
  const orgPara = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: org ? [new TextRun({ text: org, bold: true, allCaps: true, size: 26, font: FONT })] : [],
  });

  const cell = (children: Paragraph[], pct: number) => new TableCell({
    children,
    width: { size: Math.round(TEXT_WIDTH * pct / 100), type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
  });

  return new Header({
    children: [
      new Table({
        width: { size: TEXT_WIDTH, type: WidthType.DXA },
        columnWidths: [TEXT_WIDTH / 4, TEXT_WIDTH / 2, TEXT_WIDTH / 4],
        borders: NO_BORDERS,
        rows: [new TableRow({ children: [cell([logoPara], 25), cell([orgPara], 50), cell([new Paragraph({})], 25)] })],
      }),
      new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: '000000', space: 1 } }, children: [] }),
    ],
  });
}

function docxBody(blocks: Block[]): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  let listInstance = 0;
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        if (b.level === 1) {
          out.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 120, after: 360 },
            children: textRuns(b.runs, { size: 30, bold: true, allCaps: true }),
          }));
        } else if (b.level === 2) {
          out.push(new Paragraph({
            keepNext: true,
            spacing: { before: 360, after: 160 },
            border: { bottom: LINE },
            children: textRuns(b.runs, { size: 25, bold: true, allCaps: true }),
          }));
        } else {
          out.push(new Paragraph({
            keepNext: true,
            spacing: { before: 240, after: 120 },
            children: textRuns(b.runs, { bold: true }),
          }));
        }
        break;
      case 'paragraph':
        out.push(new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          spacing: { after: 160, line: 360 },
          children: textRuns(b.runs),
        }));
        break;
      case 'list':
        listInstance++;
        for (const item of b.items) {
          out.push(new Paragraph({
            spacing: { after: 60, line: 320 },
            children: textRuns(item),
            ...(b.ordered
              ? { numbering: { reference: 'ata-num', level: 0, instance: listInstance } }
              : { bullet: { level: 0 } }),
          }));
        }
        out.push(new Paragraph({ spacing: { after: 60 }, children: [] }));
        break;
      case 'table': {
        const mk = (runs: InlineRun[], header: boolean) => new TableCell({
          children: [new Paragraph({ children: textRuns(runs, { size: 22, bold: header }) })],
          ...(header ? { shading: { fill: 'E6E6E6', type: ShadingType.CLEAR, color: 'auto' } } : {}),
        });
        const n = Math.max(1, b.head.length);
        out.push(new Table({
          width: { size: TEXT_WIDTH, type: WidthType.DXA },
          columnWidths: Array.from({ length: n }, () => Math.floor(TEXT_WIDTH / n)),
          rows: [
            new TableRow({ tableHeader: true, children: b.head.map(c => mk(c, true)) }),
            ...b.rows.map(r => new TableRow({ cantSplit: true, children: r.map(c => mk(c, false)) })),
          ],
        }));
        out.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
        break;
      }
    }
  }
  return out;
}

function docxSignatures(opts: ExportOptions): (Paragraph | Table)[] {
  const sigs = signatoriesOf(opts);
  if (!sigs.length) return [];
  const cell = (s?: Signatory) => new TableCell({
    width: { size: TEXT_WIDTH / 2, type: WidthType.DXA },
    borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
    margins: { left: cmToTwip(0.4), right: cmToTwip(0.4) },
    children: s
      ? [
          new Paragraph({ spacing: { before: 960 }, children: [] }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            border: { top: LINE },
            children: [new TextRun({ text: s.name.trim(), bold: true, size: 22, font: FONT })],
          }),
          ...(s.cpf.trim()
            ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `CPF: ${s.cpf.trim()}`, size: 22, font: FONT })] })]
            : []),
          ...(s.role && s.role.trim()
            ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: s.role.trim(), size: 22, font: FONT })] })]
            : []),
        ]
      : [new Paragraph({})],
  });
  const rows: TableRow[] = [];
  for (let i = 0; i < sigs.length; i += 2) {
    rows.push(new TableRow({ cantSplit: true, children: [cell(sigs[i]), cell(sigs[i + 1])] }));
  }
  return [
    new Paragraph({ spacing: { before: 240 }, children: [] }),
    new Table({
      width: { size: TEXT_WIDTH, type: WidthType.DXA },
      columnWidths: [TEXT_WIDTH / 2, TEXT_WIDTH / 2],
      borders: NO_BORDERS,
      rows,
    }),
  ];
}

/** Gera o .docx em memória. */
export async function buildDocx(markdown: string, opts: ExportOptions): Promise<Uint8Array> {
  const header = docxHeader(opts);
  const doc = new Document({
    creator: 'Meetily',
    title: opts.title,
    styles: { default: { document: { run: { font: FONT, size: 24 } } } },
    numbering: {
      config: [{
        reference: 'ata-num',
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 }, // A4
          margin: {
            top: cmToTwip(header ? 3.5 : 2.5),
            bottom: cmToTwip(2),
            left: cmToTwip(3),
            right: cmToTwip(2),
            header: cmToTwip(1.2),
          },
        },
      },
      ...(header ? { headers: { default: header } } : {}),
      children: [...docxBody(buildBlocks(markdown, opts)), ...docxSignatures(opts)],
    }],
  });
  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Grava o .docx na pasta Downloads e devolve o caminho completo. */
export async function saveAsWord(markdown: string, opts: ExportOptions): Promise<string> {
  const bytes = await buildDocx(markdown, opts);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
  const fileName = `${safeFileName(opts.title)} - ${stamp}.docx`;
  await writeFile(fileName, bytes, { baseDir: BaseDirectory.Download });
  return await join(await downloadDir(), fileName);
}

// ---------------------------------------------------------------------------
// Logos salvos (biblioteca do app)
// ---------------------------------------------------------------------------

const LOGOS_KEY = 'export_logos';
const LOGO_SELECTED_KEY = 'export_logo_selected';

export function loadLogos(): LogoImage[] {
  try {
    const raw = localStorage.getItem(LOGOS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function saveLogos(list: LogoImage[]): boolean {
  try { localStorage.setItem(LOGOS_KEY, JSON.stringify(list)); return true; } catch { return false; }
}

export function loadSelectedLogoId(): string {
  try { return localStorage.getItem(LOGO_SELECTED_KEY) || ''; } catch { return ''; }
}

export function saveSelectedLogoId(id: string) {
  try { localStorage.setItem(LOGO_SELECTED_KEY, id); } catch { /* ignore */ }
}

/** Lê uma imagem escolhida pelo usuário e converte para PNG reduzido (máx. 600 px). */
export function imageFileToLogo(file: File): Promise<LogoImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Não foi possível ler a imagem'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Formato de imagem não suportado'));
      img.onload = () => {
        const max = 600;
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Não foi possível processar a imagem')); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve({
          id: `logo-${Date.now()}`,
          name: file.name.replace(/\.[^.]+$/, ''),
          dataUrl: canvas.toDataURL('image/png'),
          width: w,
          height: h,
        });
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
