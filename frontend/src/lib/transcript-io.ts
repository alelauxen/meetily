/**
 * Importar e exportar transcrições (versão personalizada).
 *
 * Exportar: TXT (uma linha por trecho, com [MM:SS]) ou Word (.docx), gravados em Downloads.
 * Importar: TXT/MD, Word (.docx), legendas (.srt/.vtt) ou texto colado. Se as linhas
 * tiverem tempos ([MM:SS], [HH:MM:SS] ou 00:01:02), eles são aproveitados.
 */

import { writeFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { downloadDir, join } from '@tauri-apps/api/path';
import { AlignmentType, Document, Packer, Paragraph, TextRun } from 'docx';
import JSZip from 'jszip';

export interface ExportSegment {
  text: string;
  start?: number | null; // segundos desde o início
}

export interface ImportedSegment {
  text: string;
  start: number | null;
  end: number | null;
}

// ---------------------------------------------------------------------------
// Tempos
// ---------------------------------------------------------------------------

export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !isFinite(seconds)) return '';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function parseClock(value: string): number | null {
  const parts = value.trim().replace(',', '.').split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map(p => Number(p));
  if (nums.some(n => !isFinite(n) || n < 0)) return null;
  return nums.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums[0] * 60 + nums[1];
}

// ---------------------------------------------------------------------------
// Exportar
// ---------------------------------------------------------------------------

function safeName(title: string): string {
  return (title || 'Transcricao').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Transcricao';
}

function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
}

export function buildTranscriptTxt(title: string, dateLabel: string, segments: ExportSegment[]): string {
  const lines = [title, dateLabel ? `Data: ${dateLabel}` : '', ''].filter((l, i) => i === 2 || l);
  for (const seg of segments) {
    const t = formatClock(seg.start);
    lines.push(t ? `[${t}] ${seg.text.trim()}` : seg.text.trim());
  }
  return lines.join('\r\n') + '\r\n';
}

export async function buildTranscriptDocx(title: string, dateLabel: string, segments: ExportSegment[]): Promise<Uint8Array> {
  const FONT = 'Times New Roman';
  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: title, bold: true, allCaps: true, size: 28, font: FONT })],
    }),
  ];
  if (dateLabel) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 360 },
      children: [new TextRun({ text: dateLabel, size: 22, font: FONT, color: '555555' })],
    }));
  }
  for (const seg of segments) {
    const t = formatClock(seg.start);
    const runs: TextRun[] = [];
    if (t) runs.push(new TextRun({ text: `[${t}] `, size: 20, font: FONT, color: '777777' }));
    runs.push(new TextRun({ text: seg.text.trim(), size: 24, font: FONT }));
    children.push(new Paragraph({ spacing: { after: 120, line: 320 }, children: runs }));
  }
  const doc = new Document({
    creator: 'Meetily',
    title,
    styles: { default: { document: { run: { font: FONT, size: 24 } } } },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1418, bottom: 1134, left: 1701, right: 1134 },
        },
      },
      children,
    }],
  });
  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Grava o arquivo na pasta Downloads e devolve o caminho completo. */
export async function saveToDownloads(baseTitle: string, ext: 'txt' | 'docx', data: Uint8Array): Promise<string> {
  const fileName = `${safeName(baseTitle)} - transcrição - ${stamp()}.${ext}`;
  await writeFile(fileName, data, { baseDir: BaseDirectory.Download });
  return await join(await downloadDir(), fileName);
}

export function textToBytes(text: string): Uint8Array {
  // BOM para o Bloco de Notas abrir acentos corretamente
  return new TextEncoder().encode('﻿' + text);
}

// ---------------------------------------------------------------------------
// Importar
// ---------------------------------------------------------------------------

/** Lê o texto de um .docx (parágrafos do documento principal). */
export async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('Arquivo Word inválido');
  const xml = await file.async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paragraphs = Array.from(doc.getElementsByTagNameNS(W, 'p'));
  return paragraphs
    .map(p => {
      let text = '';
      const walk = (node: Element) => {
        for (const child of Array.from(node.children)) {
          if (child.namespaceURI === W && child.localName === 't') text += child.textContent || '';
          else if (child.namespaceURI === W && child.localName === 'tab') text += '\t';
          else if (child.namespaceURI === W && (child.localName === 'br' || child.localName === 'cr')) text += '\n';
          else walk(child);
        }
      };
      walk(p);
      return text;
    })
    .join('\n');
}

/** Lê o conteúdo de um arquivo escolhido pelo usuário. */
export async function readTranscriptFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.docx')) return extractDocxText(await file.arrayBuffer());
  if (name.endsWith('.doc')) {
    throw new Error('Arquivos .doc antigos não são suportados. No Word, salve como .docx ou copie e cole o texto.');
  }
  return await file.text();
}

const SUBTITLE_TIME = /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})/;

function parseSubtitles(text: string): ImportedSegment[] {
  const out: ImportedSegment[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const idx = lines.findIndex(l => SUBTITLE_TIME.test(l));
    if (idx < 0) continue;
    const m = lines[idx].match(SUBTITLE_TIME)!;
    const body = lines.slice(idx + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (body) out.push({ text: body, start: parseClock(m[1]), end: parseClock(m[2]) });
  }
  return out;
}

/** Linha começando com tempo: "[00:12] texto", "00:12 - texto", "(01:02:03) texto". */
const LINE_TIME = /^\s*[[(]?(\d{1,2}:\d{2}(?::\d{2})?)[\])]?\s*[-–—:]?\s*(.*)$/;

/** Quebra parágrafos muito longos em blocos de frases (~600 caracteres). */
function splitLong(text: string): string[] {
  if (text.length <= 800) return [text];
  const sentences = text.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [text];
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > 600 && cur) {
      out.push(cur.trim());
      cur = '';
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Converte texto livre em trechos de transcrição. */
export function parseTranscriptText(raw: string): ImportedSegment[] {
  const text = raw.replace(/^﻿/, '').replace(/\r/g, '');
  if (/^\s*WEBVTT/.test(text) || SUBTITLE_TIME.test(text)) {
    const subs = parseSubtitles(text);
    if (subs.length) return subs;
  }

  const lines = text.split('\n').map(l => l.trim());
  const timed = lines.filter(l => LINE_TIME.test(l) && l.match(LINE_TIME)![2]).length;
  const nonEmpty = lines.filter(Boolean).length;

  // Maioria das linhas com tempo: cada linha é um trecho
  if (nonEmpty > 0 && timed / nonEmpty >= 0.5) {
    const out: ImportedSegment[] = [];
    for (const line of lines) {
      if (!line) continue;
      const m = line.match(LINE_TIME);
      if (m && m[2]) {
        out.push({ text: m[2].trim(), start: parseClock(m[1]), end: null });
      } else if (out.length) {
        out[out.length - 1].text += ' ' + line; // continuação da linha anterior
      }
      // Linhas sem tempo antes do primeiro trecho (título, data) são cabeçalho: ignoradas
    }
    for (let i = 0; i < out.length; i++) {
      const next = out[i + 1];
      if (out[i].start !== null && next && next.start !== null && next.start >= (out[i].start as number)) {
        out[i].end = next.start;
      }
    }
    return out.filter(s => s.text.trim());
  }

  // Texto sem tempos: um trecho por parágrafo (linhas em branco separam parágrafos)
  const paragraphs = text.split(/\n\s*\n/).map(p => p.split('\n').map(l => l.trim()).filter(Boolean).join(' ')).filter(Boolean);
  const base = paragraphs.length > 1 ? paragraphs : lines.filter(Boolean);
  return base.flatMap(splitLong).map(t => ({ text: t, start: null, end: null }));
}
