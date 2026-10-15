"use client";

import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { Check, FileDown, FileText, ImagePlus, Loader2, Plus, Trash2, UserPlus, X } from 'lucide-react';
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
import {
  ExportOptions,
  imageFileToLogo,
  loadLogos,
  loadSelectedLogoId,
  LogoImage,
  saveLogos,
  saveSelectedLogoId,
  extractParticipants,
  formatCpf,
  printAsPdf,
  saveAsWord,
  Signatory,
} from '@/lib/summary-export';

const ORG_KEY = 'export_org';
const SIGNATORIES_KEY = 'export_signatories';

function loadText(key: string): string {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
function loadSignatories(): Signatory[] {
  try {
    const raw = localStorage.getItem(SIGNATORIES_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
function store(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

const emptySignatory = (): Signatory => ({ name: '', cpf: '', role: '' });

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
  const [participants, setParticipants] = useState<string[]>([]);
  const [signatories, setSignatories] = useState<Signatory[]>([]);
  const [busy, setBusy] = useState<'pdf' | 'word' | null>(null);
  const [logos, setLogos] = useState<LogoImage[]>([]);
  const [selectedLogoId, setSelectedLogoId] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Ao abrir: carrega cabeçalho e assinantes salvos, e os participantes do resumo
  useEffect(() => {
    if (!open) return;
    setOrganization(loadText(ORG_KEY));
    const savedLogos = loadLogos();
    setLogos(savedLogos);
    const sel = loadSelectedLogoId();
    setSelectedLogoId(savedLogos.some(l => l.id === sel) ? sel : '');
    const saved = loadSignatories();
    setSignatories(saved.length ? saved : [emptySignatory()]);
    getMarkdown()
      .then(md => {
        const found = extractParticipants(md);
        setParticipants(found.length ? found : ['']);
      })
      .catch(() => setParticipants(['']));
    // Só recarrega ao abrir, para não apagar o que o usuário está editando
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A data da reunião já aparece no corpo da ata; o cabeçalho leva só logo e empresa.
  void meetingDate;

  // ----- logos -----
  const selectLogo = (id: string) => {
    setSelectedLogoId(id);
    saveSelectedLogoId(id);
  };
  const addLogo = async (file: File | undefined) => {
    if (!file) return;
    try {
      const logo = await imageFileToLogo(file);
      const next = [...logos, logo];
      if (!saveLogos(next)) {
        toast.error('Não há espaço para salvar mais logos. Remova algum da lista.');
        return;
      }
      setLogos(next);
      selectLogo(logo.id);
      toast.success(`Logo "${logo.name}" salvo para as próximas exportações`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não foi possível usar essa imagem');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };
  const removeLogo = (id: string) => {
    const next = logos.filter(l => l.id !== id);
    saveLogos(next);
    setLogos(next);
    if (selectedLogoId === id) selectLogo('');
  };

  // ----- participantes -----
  const setParticipant = (i: number, value: string) =>
    setParticipants(list => list.map((p, k) => (k === i ? value : p)));
  const addParticipant = () => setParticipants(list => [...list, '']);
  const removeParticipant = (i: number) =>
    setParticipants(list => (list.length > 1 ? list.filter((_, k) => k !== i) : ['']));

  // ----- assinantes -----
  const setSignatory = (i: number, field: keyof Signatory, value: string) =>
    setSignatories(list =>
      list.map((s, k) => (k === i ? { ...s, [field]: field === 'cpf' ? formatCpf(value) : value } : s)),
    );
  const addSignatory = () => setSignatories(list => [...list, emptySignatory()]);
  const removeSignatory = (i: number) =>
    setSignatories(list => (list.length > 1 ? list.filter((_, k) => k !== i) : [emptySignatory()]));

  // Usa os participantes como assinantes (mantém CPF/cargo de quem já estava na lista)
  const participantsToSignatories = () => {
    const names = participants.map(p => p.trim()).filter(Boolean);
    if (!names.length) {
      toast.error('Não há participantes na lista');
      return;
    }
    setSignatories(current => {
      const byName = new Map(current.map(s => [s.name.trim().toLowerCase(), s]));
      return names.map(n => byName.get(n.toLowerCase()) || { name: n, cpf: '', role: '' });
    });
  };

  const prepare = async (): Promise<{ markdown: string; opts: ExportOptions } | null> => {
    const markdown = await getMarkdown();
    if (!markdown.trim()) {
      toast.error('Não há resumo para exportar');
      return null;
    }
    const filledSignatories = signatories.filter(s => s.name.trim());
    const badCpf = filledSignatories.find(s => s.cpf && s.cpf.replace(/\D/g, '').length !== 11);
    if (badCpf) {
      toast.error(`CPF incompleto para ${badCpf.name}`);
      return null;
    }
    store(ORG_KEY, organization);
    store(SIGNATORIES_KEY, JSON.stringify(filledSignatories));
    return {
      markdown,
      opts: {
        title: meetingTitle,
        organization: organization.trim(),
        logo: logos.find(l => l.id === selectedLogoId) || null,
        participants,
        signatories: filledSignatories,
      },
    };
  };

  const handlePdf = async () => {
    setBusy('pdf');
    try {
      const data = await prepare();
      if (!data) return;
      onOpenChange(false);
      await printAsPdf(data.markdown, data.opts);
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
      const data = await prepare();
      if (!data) return;
      const path = await saveAsWord(data.markdown, data.opts);
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
      <DialogContent className="sm:max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Exportar documento</DialogTitle>
          <DialogDescription>
            Confira os participantes, informe os assinantes e gere o documento em PDF ou Word.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 py-2">
          {/* Cabeçalho */}
          <section className="grid gap-3">
            <div className="grid gap-2">
              <Label htmlFor="export-org">Empresa / órgão (cabeçalho, centralizado)</Label>
              <Input
                id="export-org"
                placeholder="Opcional"
                value={organization}
                onChange={e => setOrganization(e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>Logo do cabeçalho</Label>
                <Button type="button" variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()}>
                  <ImagePlus /> Adicionar logo
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/bmp,image/webp,image/svg+xml"
                  className="hidden"
                  onChange={e => addLogo(e.target.files?.[0])}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Logos adicionados ficam salvos no app. Nas próximas atas é só clicar no logo para usar.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => selectLogo('')}
                  className={`flex h-16 w-24 items-center justify-center rounded-md border text-xs ${
                    selectedLogoId === '' ? 'border-2 border-primary' : 'text-muted-foreground'
                  }`}
                >
                  Sem logo
                </button>
                {logos.map(l => (
                  <div key={l.id} className="relative">
                    <button
                      type="button"
                      title={l.name}
                      onClick={() => selectLogo(l.id)}
                      className={`flex h-16 w-24 items-center justify-center rounded-md border bg-white p-1 ${
                        selectedLogoId === l.id ? 'border-2 border-primary' : ''
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={l.dataUrl} alt={l.name} className="max-h-full max-w-full object-contain" />
                    </button>
                    {selectedLogoId === l.id && (
                      <span className="absolute left-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                    <button
                      type="button"
                      title="Remover logo da lista"
                      onClick={() => removeLogo(l.id)}
                      className="absolute -right-2 -top-2 rounded-full border bg-background p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Participantes */}
          <section className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>Participantes</Label>
              <Button type="button" variant="ghost" size="sm" onClick={addParticipant}>
                <Plus /> Adicionar participante
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Lista tirada do resumo. Corrija nomes, inclua quem faltou ou remova quem não participou.
            </p>
            <div className="grid gap-2">
              {participants.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <Input
                    aria-label={`Participante ${i + 1}`}
                    placeholder="Nome (e cargo/setor, se quiser)"
                    value={p}
                    onChange={e => setParticipant(i, e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="Remover participante"
                    onClick={() => removeParticipant(i)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          </section>

          {/* Assinantes */}
          <section className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>Assinaturas</Label>
              <div className="flex gap-1">
                <Button type="button" variant="ghost" size="sm" onClick={participantsToSignatories}>
                  <UserPlus /> Usar participantes
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={addSignatory}>
                  <Plus /> Adicionar assinante
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Cada assinante ganha uma linha de assinatura com nome, CPF e cargo. Deixe o nome em branco para não incluir.
            </p>
            <div className="grid gap-3">
              {signatories.map((s, i) => (
                <div key={i} className="grid gap-2 rounded-md border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Assinante {i + 1}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Remover assinante"
                      onClick={() => removeSignatory(i)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[2fr_1.2fr_1.5fr]">
                    <Input
                      aria-label={`Nome do assinante ${i + 1}`}
                      placeholder="Nome completo"
                      value={s.name}
                      onChange={e => setSignatory(i, 'name', e.target.value)}
                    />
                    <Input
                      aria-label={`CPF do assinante ${i + 1}`}
                      placeholder="CPF"
                      inputMode="numeric"
                      value={s.cpf}
                      onChange={e => setSignatory(i, 'cpf', e.target.value)}
                    />
                    <Input
                      aria-label={`Cargo do assinante ${i + 1}`}
                      placeholder="Cargo (opcional)"
                      value={s.role || ''}
                      onChange={e => setSignatory(i, 'role', e.target.value)}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
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
