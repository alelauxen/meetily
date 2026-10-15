'use client';

import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { ArrowRight, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Replacement {
  from: string;
  to: string;
}

interface Glossary {
  terms: string[];
  replacements: Replacement[];
}

const emptyReplacement = (): Replacement => ({ from: '', to: '' });

/** Versão personalizada: glossário de termos técnicos usado na transcrição e na ata. */
export function GlossarySettings() {
  const [termsText, setTermsText] = useState('');
  const [replacements, setReplacements] = useState<Replacement[]>([emptyReplacement()]);
  const [saved, setSaved] = useState<Glossary>({ terms: [], replacements: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const apply = (g: Glossary) => {
    setSaved(g);
    setTermsText(g.terms.join('\n'));
    setReplacements(g.replacements.length ? g.replacements : [emptyReplacement()]);
  };

  useEffect(() => {
    invoke<Glossary>('glossary_get')
      .then(apply)
      .catch(e => toast.error('Não foi possível carregar o glossário', { description: String(e) }))
      .finally(() => setLoading(false));
  }, []);

  const current: Glossary = useMemo(() => ({
    terms: termsText.split('\n').map(t => t.trim()).filter(Boolean),
    replacements: replacements
      .map(r => ({ from: r.from.trim(), to: r.to.trim() }))
      .filter(r => r.from && r.to),
  }), [termsText, replacements]);

  const isDirty = JSON.stringify(current) !== JSON.stringify(saved);

  const setReplacement = (i: number, field: keyof Replacement, value: string) =>
    setReplacements(list => list.map((r, k) => (k === i ? { ...r, [field]: value } : r)));
  const addReplacement = () => setReplacements(list => [...list, emptyReplacement()]);
  const removeReplacement = (i: number) =>
    setReplacements(list => (list.length > 1 ? list.filter((_, k) => k !== i) : [emptyReplacement()]));

  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await invoke<Glossary>('glossary_set', { glossary: current });
      apply(result);
      toast.success('Glossário salvo', {
        description: 'Vale para as próximas gravações e para os próximos resumos.',
      });
    } catch (e) {
      toast.error('Não foi possível salvar o glossário', { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando glossário…
      </div>
    );
  }

  return (
    <div className="space-y-6 py-6">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-3">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Termos técnicos</h3>
          <p className="text-sm text-gray-600">
            Um termo por linha: nomes de programas, siglas, bairros, órgãos, pessoas. O modelo de
            transcrição usa esta lista como dica para reconhecer essas palavras (funciona com os
            modelos Whisper), e a IA usa a grafia correta ao escrever a ata.
          </p>
        </div>
        <textarea
          value={termsText}
          onChange={e => setTermsText(e.target.value)}
          placeholder={'Metashape\nortomosaico\nnuvem de pontos\nGSD\ncadastro multifinalitário'}
          rows={10}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <p className="text-xs text-gray-500">
          {current.terms.length} {current.terms.length === 1 ? 'termo' : 'termos'}. Prefira os termos
          que o modelo erra; listas muito longas são cortadas na dica do modelo (cerca de 600 caracteres).
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Correções automáticas</h3>
            <p className="text-sm text-gray-600">
              Quando a transcrição escrever o termo da esquerda, ele é trocado pelo da direita.
              Vale para qualquer modelo. Não diferencia maiúsculas e só troca palavras inteiras.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addReplacement}>
            <Plus /> Adicionar correção
          </Button>
        </div>
        <div className="grid gap-2">
          <div className="hidden sm:grid grid-cols-[1fr_auto_1fr_auto] gap-2 text-xs font-medium text-gray-500">
            <Label>Quando aparecer</Label>
            <span />
            <Label>Trocar por</Label>
            <span />
          </div>
          {replacements.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
              <Input
                aria-label={`Texto errado ${i + 1}`}
                placeholder="meta shape"
                value={r.from}
                onChange={e => setReplacement(i, 'from', e.target.value)}
              />
              <ArrowRight className="h-4 w-4 text-gray-400" />
              <Input
                aria-label={`Texto correto ${i + 1}`}
                placeholder="Metashape"
                value={r.to}
                onChange={e => setReplacement(i, 'to', e.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title="Remover correção"
                onClick={() => removeReplacement(i)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        {isDirty && <span className="text-sm text-amber-600">Alterações não salvas</span>}
        <Button onClick={handleSave} disabled={saving || !isDirty}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          Salvar glossário
        </Button>
      </div>
    </div>
  );
}
