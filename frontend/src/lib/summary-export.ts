/**
 * Exportação do resumo/ata para PDF e Word (versão personalizada).
 *
 * - PDF: abre a janela de impressão do sistema com a ata formatada
 *   (no Windows, escolher "Microsoft Print to PDF" ou "Salvar como PDF").
 * - Word: grava um arquivo .doc (HTML compatível com o Word) na pasta Downloads.
 */

import { writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { downloadDir, join } from '@tauri-apps/api/path';

export interface Signatory {
  name: string;
  cpf: string;
  role?: string;
}

export interface ExportOptions {
  title: string;
  date?: string;
  organization?: string;
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

function inline(s: string): string {
  let out = esc(s);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/`(.+?)`/g, '$1');
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return out;
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function isSep(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

/** Conversor simples de Markdown para HTML (títulos, listas, tabelas, negrito). */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let i = 0;
  const flush = () => {
    if (para.length) {
      out.push('<p>' + inline(para.join(' ')) + '</p>');
      para = [];
    }
  };

  while (i < lines.length) {
    const t = lines[i].trim();
    let m: RegExpMatchArray | null;
    if (!t) { flush(); i++; continue; }

    if ((m = t.match(/^(#{1,6})\s+(.*)$/))) {
      flush();
      const n = Math.min(m[1].length, 3);
      out.push(`<h${n}>${inline(m[2].replace(/#+$/, '').trim())}</h${n}>`);
      i++; continue;
    }
    if ((m = t.match(/^\*\*([^*]+)\*\*:?$/))) {
      flush();
      out.push(`<h2>${esc(m[1])}</h2>`);
      i++; continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); i++; continue; }

    if (t.startsWith('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      flush();
      const head = cells(t);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const r = cells(lines[i]);
        if (!isSep(lines[i]) && r.some(c => c)) rows.push(r);
        i++;
      }
      let h = '<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      rows.forEach(r => {
        h += '<tr>' + head.map((_, k) => `<td>${inline(r[k] || '')}</td>`).join('') + '</tr>';
      });
      out.push(h + '</tbody></table>');
      continue;
    }

    if (/^([-*+]|\d+[.)])\s+/.test(t)) {
      flush();
      const ordered = /^\d/.test(t);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const txt = lines[i].trim().replace(/^([-*+]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s*/, '');
        items.push(`<li>${inline(txt)}</li>`);
        i++;
      }
      out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'));
      continue;
    }

    para.push(t);
    i++;
  }
  flush();
  return out.join('\n');
}

const DOC_CSS = `
  body { font-family: "Times New Roman", Times, serif; font-size: 12pt; line-height: 1.5; color: #000; margin: 0; }
  .cab { text-align: center; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 18px; }
  .cab .org { font-weight: bold; text-transform: uppercase; font-size: 13pt; }
  .cab .data { font-size: 11pt; }
  h1 { font-size: 15pt; text-align: center; text-transform: uppercase; margin: 12px 0 18px; }
  h2 { font-size: 12.5pt; text-transform: uppercase; border-bottom: 1px solid #000; padding-bottom: 2px; margin: 18px 0 8px; }
  h3 { font-size: 12pt; margin: 14px 0 6px; }
  p { text-align: justify; margin: 0 0 8px; }
  ul, ol { margin: 0 0 8px; padding-left: 24px; }
  table { border-collapse: collapse; width: 100%; margin: 6px 0 10px; font-size: 11pt; }
  th, td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; text-align: left; }
  th { background: #e6e6e6; }
  table.assin { margin-top: 36px; border: 0; width: 100%; }
  table.assin td { border: 0; width: 50%; padding: 48px 16px 0; text-align: center; vertical-align: top; font-size: 11pt; page-break-inside: avoid; }
  table.assin .linha { border-top: 1px solid #000; padding-top: 4px; }
  table.assin .nome { font-weight: bold; }
`;

/** Monta o corpo da ata (sem <html>), a partir do Markdown do resumo. */
export function buildBodyHtml(markdown: string, opts: ExportOptions): string {
  let html = '';
  if (opts.organization || opts.date) {
    html += '<div class="cab">';
    if (opts.organization) html += `<div class="org">${esc(opts.organization)}</div>`;
    if (opts.date) html += `<div class="data">${esc(opts.date)}</div>`;
    html += '</div>';
  }
  const md = opts.participants ? replaceParticipants(markdown, opts.participants) : markdown;
  let body = markdownToHtml(md);
  // Usa o título gerado pela IA; se não houver, usa o título da reunião.
  if (!/^<h1>/.test(body)) body = `<h1>${esc(opts.title || 'Ata de Reunião')}</h1>` + body;
  html += body;
  const sigs = (opts.signatories || []).filter(s => s.name.trim());
  if (sigs.length) {
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
    html += `<table class="assin">${rows}</table>`;
  }
  return html;
}

export function safeFileName(title: string): string {
  return (title || 'Ata de Reuniao').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Ata de Reuniao';
}

/** Abre a janela de impressão com a ata formatada (para salvar em PDF). */
export function printAsPdf(bodyHtml: string, title: string): Promise<void> {
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
    doc.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(title)}</title>
      <style>@page { size: A4; margin: 2.5cm 2cm 2cm 3cm; } ${DOC_CSS}</style></head>
      <body>${bodyHtml}</body></html>`);
    doc.close();

    setTimeout(() => {
      try {
        win.focus();
        win.print();
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        setTimeout(() => iframe.remove(), 2000);
      }
    }, 300);
  });
}

/** Grava um arquivo .doc (abre no Word) na pasta Downloads e devolve o caminho completo. */
export async function saveAsWord(bodyHtml: string, title: string): Promise<string> {
  const docHtml =
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">' +
    `<head><meta charset="utf-8"><title>${esc(title)}</title><style>` +
    '@page Section1 { size: 21cm 29.7cm; margin: 2.5cm 2cm 2cm 3cm; } div.Section1 { page: Section1; } ' +
    DOC_CSS +
    `</style></head><body><div class="Section1">${bodyHtml}</div></body></html>`;

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
  const fileName = `${safeFileName(title)} - ${stamp}.doc`;
  await writeTextFile(fileName, '﻿' + docHtml, { baseDir: BaseDirectory.Download });
  return await join(await downloadDir(), fileName);
}
