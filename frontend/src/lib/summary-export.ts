/**
 * Exportação do resumo/ata para PDF e Word (versão personalizada).
 *
 * - PDF: abre a janela de impressão do sistema com a ata formatada
 *   (no Windows, escolher "Microsoft Print to PDF" ou "Salvar como PDF").
 * - Word: grava um arquivo .doc (HTML compatível com o Word) na pasta Downloads.
 */

import { writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { downloadDir, join } from '@tauri-apps/api/path';

export interface ExportOptions {
  title: string;
  date?: string;
  organization?: string;
  signatures?: string[];
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
  .assin { margin-top: 48px; }
  .assin div { display: inline-block; width: 45%; margin: 40px 2% 0; border-top: 1px solid #000; text-align: center; padding-top: 4px; font-size: 11pt; }
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
  let body = markdownToHtml(markdown);
  // Usa o título gerado pela IA; se não houver, usa o título da reunião.
  if (!/^<h1>/.test(body)) body = `<h1>${esc(opts.title || 'Ata de Reunião')}</h1>` + body;
  html += body;
  const sigs = (opts.signatures || []).map(s => s.trim()).filter(Boolean);
  if (sigs.length) {
    html += '<div class="assin">' + sigs.map(n => `<div>${esc(n)}</div>`).join('') + '</div>';
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
