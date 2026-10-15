"use client";

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { useState } from 'react';
import { Copy, Save, Loader2, FileDown } from 'lucide-react';
import { ExportSummaryDialog } from './ExportSummaryDialog';
import Analytics from '@/lib/analytics';

interface SummaryUpdaterButtonGroupProps {
  isSaving: boolean;
  isDirty: boolean;
  onSave: () => Promise<void>;
  onCopy: () => Promise<void>;
  getMarkdown?: () => Promise<string>;
  meetingTitle?: string;
  meetingDate?: string;
}

export function SummaryUpdaterButtonGroup({
  isSaving,
  isDirty,
  onSave,
  onCopy,
  getMarkdown,
  meetingTitle = '',
  meetingDate,
}: SummaryUpdaterButtonGroupProps) {
  const [exportOpen, setExportOpen] = useState(false);

  return (
    <>
    <ButtonGroup>
      {/* Save button */}
      <Button
        variant="outline"
        size="sm"
        className={`${isDirty ? 'bg-green-200' : ""}`}
        title={isSaving ? "Saving" : "Save Changes"}
        onClick={() => {
          Analytics.trackButtonClick('save_changes', 'meeting_details');
          onSave();
        }}
        disabled={isSaving}
      >
        {isSaving ? (
          <>
            <Loader2 className="animate-spin" />
            <span className="hidden @[40rem]:inline">Saving...</span>
          </>
        ) : (
          <>
            <Save />
            <span className="hidden @[40rem]:inline">Save</span>
          </>
        )}
      </Button>

      {/* Copy button */}
      <Button
        variant="outline"
        size="sm"
        title="Copy Summary"
        onClick={() => {
          Analytics.trackButtonClick('copy_summary', 'meeting_details');
          onCopy();
        }}
        className="cursor-pointer"
      >
        <Copy />
        <span className="hidden @[40rem]:inline">Copy</span>
      </Button>

      {/* Exportar PDF / Word (versão personalizada) */}
      {getMarkdown && (
        <Button
          variant="outline"
          size="sm"
          title="Exportar em PDF ou Word"
          onClick={() => setExportOpen(true)}
          className="cursor-pointer"
        >
          <FileDown />
          <span className="hidden @[40rem]:inline">Exportar</span>
        </Button>
      )}

    </ButtonGroup>
    {getMarkdown && (
      <ExportSummaryDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        getMarkdown={getMarkdown}
        meetingTitle={meetingTitle}
        meetingDate={meetingDate}
      />
    )}
    </>
  );
}
