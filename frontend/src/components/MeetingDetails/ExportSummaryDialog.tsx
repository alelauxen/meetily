"use client";

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { FileDown, FileText, Loader2 } from 'lucide-react';
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
import { buildBodyHtml, printAsPdf, saveAsWord } from '@/lib/summary-export';

const ORG_KEY = 'export_org';
const SIG_KEY = 'export_signatures';

function load(key: string): string {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
function store(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

interface ExportSummaryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  getMarkdown: () => Promise<string>;
  meetingTitle: string;
  meetingDate?: string;
}

export function ExportSummaryDialog({
  open,
  onOpenChange,
  getMarkdown,
  meetingTitle,
  meetingDate,
}: ExportSummaryDialogProps) {
  const [organization, setOrganization] = useState('');
  const [signatures, setSignatures] = useState('');
  const [busy, setBusy] = useState<'pdf' | 'word' | null>(null);

  useEffect(() => {
    if (open) {
      setOrganization(load(ORG_KEY));
      setSignatures(load(SIG_KEY));
    }
  }, [open]);

  const dateLabel = meetingDate
    ? new Date(meetingDate).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
    : undefined;

  const prepare = async (): Promise<string | null> => {
    const markdown = await getMarkdown();
    if (!markdown.trim()) {
      toast.error('Não há resumo para exportar');
      return null;
    }
    store(ORG_KEY, organization);
    store(SIG_KEY, signatures);
    return buildBodyHtml(markdown, {
      title: meetingTitle,
      date: dateLabel,
      organization: organization.trim(),
      signatures: signatures.split(','),
    });
  };

  const handlePdf = async () => {
    setBusy('pdf');
    try {
      const body = await prepare();
      if (!body) return;
      onOpenChange(false);
      await printAsPdf(body, meetingTitle);
      toast.info('Na janela de impressão, escolha "Microsoft Print to PDF" (ou "Salvar como PDF")');
    } catch (e) {
      console.error('Falha ao exportar PDF:', e);
      toast.error('Não foi possível gerar o PDF');
    } finally {
      setBusy(null);
    }
  };

  const handleWord = async () => {
    setBusy('word');
    try {
      const body = await prepare();
      if (!body) return;
      const path = await saveAsWord(body, meetingTitle);
      onOpenChange(false);
      toast.success('Arquivo Word salvo em Downloads', {
        description: path,
        action: {
          label: 'Abrir',
          onClick: () => { invoke('open_exported_file', { path }).catch(err => toast.error(String(err))); },
        },
        duration: 10000,
      });
    } catch (e) {
      console.error('Falha ao exportar Word:', e);
      toast.error('Não foi possível salvar o arquivo Word');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Exportar documento</DialogTitle>
          <DialogDescription>
            Gera o resumo formatado em A4, com cabeçalho e linhas de assinatura opcionais.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="export-org">Empresa / órgão (cabeçalho)</Label>
            <Input
              id="export-org"
              placeholder="Opcional"
              value={organization}
              onChange={e => setOrganization(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="export-sig">Assinaturas (nomes separados por vírgula)</Label>
            <Input
              id="export-sig"
              placeholder="Opcional — ex.: Fulano, Beltrano"
              value={signatures}
              onChange={e => setSignatures(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={handleWord} disabled={busy !== null}>
            {busy === 'word' ? <Loader2 className="animate-spin" /> : <FileText />}
            Baixar Word
          </Button>
          <Button onClick={handlePdf} disabled={busy !== null}>
            {busy === 'pdf' ? <Loader2 className="animate-spin" /> : <FileDown />}
            Salvar em PDF
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
