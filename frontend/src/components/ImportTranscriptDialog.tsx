"use client";

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { ClipboardPaste, FileUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { formatClock, parseTranscriptText, readTranscriptFile } from '@/lib/transcript-io';

interface ImportTranscriptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Versão personalizada: cria uma reunião a partir de uma transcrição já pronta
 * (arquivo .txt/.md/.docx/.srt/.vtt ou texto colado). Depois é só gerar a ata.
 */
export function ImportTranscriptDialog({ open, onOpenChange }: ImportTranscriptDialogProps) {
  const router = useRouter();
  const { refetchMeetings, setCurrentMeeting } = useSidebar();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);

  const segments = useMemo(() => parseTranscriptText(text), [text]);
  const hasTimes = segments.some(s => s.start !== null);

  const reset = () => {
    setTitle('');
    setText('');
    setFileName('');
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setLoadingFile(true);
    try {
      const content = await readTranscriptFile(file);
      setText(content);
      setFileName(file.name);
      if (!title.trim()) setTitle(file.name.replace(/\.[^.]+$/, ''));
    } catch (e) {
      toast.error('Não foi possível ler o arquivo', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoadingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleImport = async () => {
    if (!segments.length) {
      toast.error('Não há texto para importar');
      return;
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const meetingTitle = title.trim() || `Transcrição importada ${new Date().toLocaleDateString('pt-BR')}`;
      const transcripts = segments.map((s, i) => ({
        id: `imported-${Date.now()}-${i}`,
        text: s.text,
        timestamp: now,
        ...(s.start !== null ? { audio_start_time: s.start } : {}),
        ...(s.end !== null ? { audio_end_time: s.end } : {}),
        ...(s.start !== null && s.end !== null ? { duration: Math.max(0, s.end - s.start) } : {}),
      }));
      const result = await invoke<{ meeting_id: string }>('api_save_transcript', {
        meetingTitle,
        transcripts,
        folderPath: null,
      });
      await refetchMeetings();
      setCurrentMeeting({ id: result.meeting_id, title: meetingTitle });
      toast.success('Transcrição importada', { description: 'Agora é só escolher o modelo e gerar o resumo.' });
      onOpenChange(false);
      reset();
      router.push(`/meeting-details?id=${result.meeting_id}`);
    } catch (e) {
      toast.error('Não foi possível importar a transcrição', { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importar transcrição</DialogTitle>
          <DialogDescription>
            Abra um arquivo (.txt, .docx, .md, .srt ou .vtt) ou cole o texto. Uma nova reunião é
            criada com essa transcrição, e a ata é gerada normalmente.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="import-title">Título da reunião</Label>
            <Input
              id="import-title"
              placeholder="Ex.: Reunião de planejamento - 23/10"
              value={title}
              onChange={e => setTitle(e.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={loadingFile}>
              {loadingFile ? <Loader2 className="animate-spin" /> : <FileUp />}
              Abrir arquivo
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  const clip = await navigator.clipboard.readText();
                  if (clip.trim()) { setText(clip); setFileName(''); }
                  else toast.info('A área de transferência está vazia');
                } catch {
                  toast.info('Clique na caixa abaixo e use Ctrl+V para colar');
                }
              }}
            >
              <ClipboardPaste /> Colar
            </Button>
            {fileName && <span className="text-xs text-muted-foreground truncate">Arquivo: {fileName}</span>}
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.docx,.srt,.vtt,text/plain"
              className="hidden"
              onChange={e => handleFile(e.target.files?.[0])}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="import-text">Texto da transcrição</Label>
            <textarea
              id="import-text"
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={'Cole aqui o texto. Se as linhas tiverem tempo, ele é aproveitado:\n[00:05] Bom dia a todos.\n[00:12] Vamos começar pela pauta.'}
              rows={12}
              className="w-full rounded-md border border-input px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              {segments.length
                ? `${segments.length} ${segments.length === 1 ? 'trecho' : 'trechos'}${hasTimes ? ', com tempos' : ', sem tempos'}`
                  + (hasTimes && segments[0].start !== null ? ` (começa em ${formatClock(segments[0].start)})` : '')
                : 'Nenhum texto ainda.'}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</Button>
          <Button onClick={handleImport} disabled={saving || !segments.length}>
            {saving ? <Loader2 className="animate-spin" /> : <FileUp />}
            Importar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
