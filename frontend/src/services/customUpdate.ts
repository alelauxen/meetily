/**
 * Verificação de atualização da versão personalizada (github.com/alelauxen/meetily).
 * Substitui a atualização do Meetily original: só consulta e abre a página de download.
 */

import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

export const CUSTOM_RELEASES_PAGE = 'https://github.com/alelauxen/meetily/releases/latest';

export interface CustomUpdateInfo {
  current_build: number | null;
  latest_build: number | null;
  latest_name: string;
  release_url: string;
  update_available: boolean;
}

export async function openReleasesPage(url: string = CUSTOM_RELEASES_PAGE): Promise<void> {
  try {
    await invoke('open_external_url', { url });
  } catch (error) {
    console.error('Failed to open releases page:', error);
    toast.error('Não foi possível abrir o navegador');
  }
}

export async function getCustomBuildNumber(): Promise<number | null> {
  try {
    return (await invoke<number | null>('get_custom_build_number')) ?? null;
  } catch {
    return null;
  }
}

/** Consulta o GitHub e mostra o resultado em um aviso, com botão para baixar. */
export async function checkCustomUpdateWithToast(): Promise<CustomUpdateInfo | null> {
  try {
    const info = await invoke<CustomUpdateInfo>('check_custom_update');
    if (info.update_available) {
      toast.info('Nova versão disponível', {
        description: `${info.latest_name}. Baixe o arquivo terminado em -setup.exe e instale por cima.`,
        action: { label: 'Baixar', onClick: () => { openReleasesPage(info.release_url); } },
        duration: 15000,
      });
    } else if (info.current_build === null) {
      toast.info('Não foi possível identificar o número desta versão', {
        description: `Última versão publicada: ${info.latest_name}`,
        action: { label: 'Abrir página', onClick: () => { openReleasesPage(info.release_url); } },
        duration: 10000,
      });
    } else {
      toast.success(`Você já está na versão mais recente (build ${info.current_build})`);
    }
    return info;
  } catch (error) {
    console.error('Failed to check for updates:', error);
    toast.error('Não foi possível verificar atualizações', {
      description: String(error),
      action: { label: 'Abrir página', onClick: () => { openReleasesPage(); } },
      duration: 10000,
    });
    return null;
  }
}
