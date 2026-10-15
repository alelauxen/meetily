'use client';

import { useCallback, useRef, useReducer, startTransition, useEffect, useState, memo, useMemo, Fragment } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { findAll } from "@/lib/text-find";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useTranscriptStreaming } from "@/hooks/useTranscriptStreaming";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { RecordingStatusBar } from "./RecordingStatusBar";
import { motion, AnimatePresence } from "framer-motion";
import { TranscriptSegmentData } from "@/types";

export interface VirtualizedTranscriptViewProps {
    /** Transcript segments to display */
    segments: TranscriptSegmentData[];
    /** Whether recording is in progress */
    isRecording?: boolean;
    /** Whether recording is paused */
    isPaused?: boolean;
    /** Whether processing/finalizing transcription */
    isProcessing?: boolean;
    /** Whether stopping */
    isStopping?: boolean;
    /** Enable streaming effect for latest segment */
    enableStreaming?: boolean;
    /** Show confidence indicators */
    showConfidence?: boolean;
    /** Completely disable auto-scroll behavior (for meeting details page) */
    disableAutoScroll?: boolean;

    // Pagination props (infinite scroll)
    hasMore?: boolean;
    isLoadingMore?: boolean;
    totalCount?: number;
    loadedCount?: number;
    onLoadMore?: () => void;

    /** Versão personalizada: termo vindo da busca da barra lateral (abre a busca já preenchida). */
    initialSearchQuery?: string;
    /** Habilita a busca na transcrição (barra + Ctrl+F). */
    enableFind?: boolean;
}

/** Trecho grifado dentro de um segmento. */
interface SegmentHighlight {
    start: number;
    end: number;
    active: boolean;
}

// Threshold for enabling virtualization (below this, use simple rendering)
const VIRTUALIZATION_THRESHOLD = 10;

// Helper function to format seconds as recording-relative time [MM:SS]
function formatRecordingTime(seconds: number | undefined): string {
    if (seconds === undefined) return '[--:--]';

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;

    return `[${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

// Helper function to remove filler words and repetitions
function cleanStopWords(text: string): string {
    const stopWords = ['uh', 'um', 'er', 'ah', 'hmm', 'hm', 'eh', 'oh'];

    let cleanedText = text;
    stopWords.forEach(word => {
        const pattern = new RegExp(`\\b${word}\\b[,\\s]*`, 'gi');
        cleanedText = cleanedText.replace(pattern, ' ');
    });

    return cleanedText.replace(/\s+/g, ' ').trim();
}

/** Texto exibido de um segmento (a busca precisa usar exatamente o mesmo texto). */
function segmentDisplayText(text: string): string {
    return cleanStopWords(text) || (text.trim() === '' ? '[Silence]' : text);
}

/** Renderiza o texto com os trechos grifados, no estilo do Ctrl+F. */
function renderHighlighted(text: string, highlights?: SegmentHighlight[]) {
    if (!highlights || highlights.length === 0) return text;
    const parts: React.ReactNode[] = [];
    let last = 0;
    highlights.forEach((h, i) => {
        if (h.start > last) parts.push(<Fragment key={`t${i}`}>{text.slice(last, h.start)}</Fragment>);
        parts.push(
            <mark
                key={`m${i}`}
                data-find-active={h.active ? 'true' : undefined}
                className={h.active ? 'bg-orange-400 text-gray-900 rounded-sm' : 'bg-yellow-200 text-gray-900 rounded-sm'}
            >
                {text.slice(h.start, h.end)}
            </mark>
        );
        last = h.end;
    });
    if (last < text.length) parts.push(<Fragment key="end">{text.slice(last)}</Fragment>);
    return parts;
}

// Memoized transcript segment component
const TranscriptSegment = memo(function TranscriptSegment({
    id,
    timestamp,
    text,
    confidence,
    isStreaming,
    showConfidence,
    highlights,
}: {
    id: string;
    timestamp: number;
    text: string;
    confidence?: number;
    isStreaming: boolean;
    showConfidence: boolean;
    highlights?: SegmentHighlight[];
}) {
    const displayText = segmentDisplayText(text);
    const content = renderHighlighted(displayText, highlights);

    return (
        <div id={`segment-${id}`} className="mb-3">
            <div className="flex items-start gap-2">
                <Tooltip>
                    <TooltipTrigger>
                        <span className="text-xs text-gray-400 mt-1 flex-shrink-0 min-w-[50px]">
                            {formatRecordingTime(timestamp)}
                        </span>
                    </TooltipTrigger>
                    <TooltipContent>
                        {confidence !== undefined && showConfidence && (
                            <ConfidenceIndicator confidence={confidence} showIndicator={showConfidence} />
                        )}
                    </TooltipContent>
                </Tooltip>
                <div className="flex-1">
                    {isStreaming ? (
                        <div className="bg-gray-100 border border-gray-200 rounded-lg px-3 py-2">
                            <p className="text-base text-gray-800 leading-relaxed">{content}</p>
                        </div>
                    ) : (
                        <p className="text-base text-gray-800 leading-relaxed">{content}</p>
                    )}
                </div>
            </div>
        </div>
    );
});

export const VirtualizedTranscriptView: React.FC<VirtualizedTranscriptViewProps> = ({
    segments,
    isRecording = false,
    isPaused = false,
    isProcessing = false,
    isStopping = false,
    enableStreaming = false,
    showConfidence = true,
    disableAutoScroll = false,
    hasMore = false,
    isLoadingMore = false,
    totalCount = 0,
    loadedCount = 0,
    onLoadMore,
    initialSearchQuery = '',
    enableFind = false,
}) => {
    // Create scroll ref first - shared between virtualizer and auto-scroll hook
    const scrollRef = useRef<HTMLDivElement>(null);
    // Ref for infinite scroll trigger element
    const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

    // Force re-render without flushSync (avoids React warning)
    const [, rerender] = useReducer((x: number) => x + 1, 0);

    // Setup virtualizer for efficient rendering of large lists
    const virtualizer = useVirtualizer({
        count: segments.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 60, // Estimated height per segment
        overscan: 10, // Render extra items above/below viewport
        onChange: () => {
            startTransition(() => {
                rerender();
            });
        },
    });

    // Custom hook for auto-scrolling (supports both virtualized and non-virtualized)
    useAutoScroll({
        scrollRef,
        segments,
        isRecording,
        isPaused,
        virtualizer,
        virtualizationThreshold: VIRTUALIZATION_THRESHOLD,
        disableAutoScroll,
    });

    // Streaming text effect hook (typewriter animation for new transcripts)
    const { streamingSegmentId, getDisplayText } = useTranscriptStreaming(
        segments,
        isRecording,
        enableStreaming
    );

    // Infinite scroll: IntersectionObserver to trigger loading more
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording || segments.length === 0) {
            return;
        }

        const triggerElement = loadMoreTriggerRef.current;
        if (!triggerElement) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
            },
            {
                root: null,
                rootMargin: '100px',
                threshold: 0,
            }
        );

        observer.observe(triggerElement);

        return () => observer.disconnect();
    }, [hasMore, isLoadingMore, onLoadMore, isRecording, segments.length]);

    // Scroll-based fallback for fast scrolling
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording) return;

        const scrollElement = scrollRef.current;
        if (!scrollElement) return;

        let ticking = false;

        const handleScroll = () => {
            if (ticking || isLoadingMore || !hasMore) return;

            ticking = true;
            requestAnimationFrame(() => {
                const { scrollTop, scrollHeight, clientHeight } = scrollElement;
                const scrollBottom = scrollHeight - scrollTop - clientHeight;

                // Trigger load when within 200px of bottom
                if (scrollBottom < 200 && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
                ticking = false;
            });
        };

        scrollElement.addEventListener('scroll', handleScroll, { passive: true });
        return () => scrollElement.removeEventListener('scroll', handleScroll);
    }, [onLoadMore, hasMore, isLoadingMore, isRecording]);

    // Use simple rendering for small lists, virtualization for large lists
    const useVirtualization = segments.length >= VIRTUALIZATION_THRESHOLD;

    // ------------------------------------------------------------------
    // Busca na transcrição (versão personalizada), no estilo do Ctrl+F
    // ------------------------------------------------------------------
    const [findOpen, setFindOpen] = useState(false);
    const [findQuery, setFindQuery] = useState('');
    const [currentMatch, setCurrentMatch] = useState(0);
    const findInputRef = useRef<HTMLInputElement>(null);

    // Termo vindo da barra lateral: abre a busca já preenchida
    useEffect(() => {
        if (!enableFind) return;
        const q = initialSearchQuery.trim();
        if (q) {
            setFindQuery(q);
            setFindOpen(true);
            setCurrentMatch(0);
        }
    }, [initialSearchQuery, enableFind]);

    // Ctrl+F abre a busca; Esc fecha
    useEffect(() => {
        if (!enableFind) return;
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                setFindOpen(true);
                setTimeout(() => {
                    findInputRef.current?.focus();
                    findInputRef.current?.select();
                }, 0);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [enableFind]);

    const activeQuery = findOpen ? findQuery.trim() : '';

    // Todas as ocorrências, na ordem da transcrição
    const matches = useMemo(() => {
        if (!activeQuery) return [] as Array<{ seg: number; start: number; end: number }>;
        const out: Array<{ seg: number; start: number; end: number }> = [];
        segments.forEach((segment, seg) => {
            for (const [start, end] of findAll(segmentDisplayText(segment.text), activeQuery)) {
                out.push({ seg, start, end });
            }
        });
        return out;
    }, [segments, activeQuery]);

    const safeCurrent = matches.length ? Math.min(currentMatch, matches.length - 1) : 0;

    // Grifos por segmento
    const highlightsBySegment = useMemo(() => {
        const map = new Map<number, SegmentHighlight[]>();
        matches.forEach((m, i) => {
            const list = map.get(m.seg) || [];
            list.push({ start: m.start, end: m.end, active: i === safeCurrent });
            map.set(m.seg, list);
        });
        return map;
    }, [matches, safeCurrent]);

    // Com a busca aberta, carrega o restante da transcrição para achar tudo
    useEffect(() => {
        if (activeQuery && hasMore && !isLoadingMore && onLoadMore && !isRecording) {
            onLoadMore();
        }
    }, [activeQuery, hasMore, isLoadingMore, onLoadMore, isRecording]);

    // Rola até a ocorrência atual
    const current = matches[safeCurrent];
    const currentKey = current ? `${current.seg}:${current.start}` : '';
    useEffect(() => {
        if (!current) return;
        const segment = segments[current.seg];
        if (!segment) return;
        if (useVirtualization) {
            virtualizer.scrollToIndex(current.seg, { align: 'center' });
        }
        // Ajuste fino depois que o segmento é desenhado
        const t = setTimeout(() => {
            const el = scrollRef.current?.querySelector('mark[data-find-active="true"]')
                || document.getElementById(`segment-${segment.id}`);
            el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 80);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentKey]);

    const goTo = (delta: number) => {
        if (!matches.length) return;
        setCurrentMatch(i => (Math.min(i, matches.length - 1) + delta + matches.length) % matches.length);
    };
    const closeFind = () => {
        setFindOpen(false);
        setCurrentMatch(0);
    };

    return (
        <div ref={scrollRef} className="flex flex-col h-full overflow-y-auto px-4 py-2">
            {/* Barra de busca na transcrição */}
            {enableFind && findOpen && (
                <div className="sticky top-0 z-20 -mx-4 mb-2 flex items-center gap-2 border-b border-gray-200 bg-white px-4 py-2 shadow-sm">
                    <Search className="h-4 w-4 flex-shrink-0 text-gray-400" />
                    <input
                        ref={findInputRef}
                        autoFocus
                        value={findQuery}
                        onChange={e => { setFindQuery(e.target.value); setCurrentMatch(0); }}
                        onKeyDown={e => {
                            if (e.key === 'Enter') { e.preventDefault(); goTo(e.shiftKey ? -1 : 1); }
                            if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
                        }}
                        placeholder="Buscar na transcrição"
                        className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <span className="flex-shrink-0 text-xs tabular-nums text-gray-500">
                        {activeQuery
                            ? (matches.length ? `${safeCurrent + 1} de ${matches.length}` : 'Nenhum resultado')
                            : ''}
                        {activeQuery && hasMore ? ' (carregando…)' : ''}
                    </span>
                    <button type="button" title="Anterior (Shift+Enter)" onClick={() => goTo(-1)}
                        disabled={!matches.length}
                        className="rounded p-1 text-gray-600 hover:bg-gray-100 disabled:opacity-40">
                        <ChevronUp className="h-4 w-4" />
                    </button>
                    <button type="button" title="Próximo (Enter)" onClick={() => goTo(1)}
                        disabled={!matches.length}
                        className="rounded p-1 text-gray-600 hover:bg-gray-100 disabled:opacity-40">
                        <ChevronDown className="h-4 w-4" />
                    </button>
                    <button type="button" title="Fechar (Esc)" onClick={closeFind}
                        className="rounded p-1 text-gray-600 hover:bg-gray-100">
                        <X className="h-4 w-4" />
                    </button>
                </div>
            )}
            {/* Recording Status Bar - Sticky at top, always visible when recording */}
            <AnimatePresence>
                {isRecording && (
                    <div className="sticky top-0 z-10 bg-white pb-2">
                        <RecordingStatusBar isPaused={isPaused} />
                    </div>
                )}
            </AnimatePresence>

            {/* Content - add padding when recording to prevent overlap */}
            <div className={isRecording ? 'pt-2' : ''}>
            {segments.length === 0 ? (
                // Empty state
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center text-gray-500 mt-8"
                >
                    {isRecording ? (
                        <>
                            <div className="flex items-center justify-center mb-3">
                                <div className={`w-3 h-3 rounded-full ${isPaused ? 'bg-orange-500' : 'bg-blue-500 animate-pulse'}`}></div>
                            </div>
                            <p className="text-sm text-gray-600">
                                {isPaused ? 'Recording paused' : 'Listening for speech...'}
                            </p>
                            <p className="text-xs mt-1 text-gray-400">
                                {isPaused ? 'Click resume to continue recording' : 'Speak to see live transcription'}
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="text-lg font-semibold">Welcome to meetily!</p>
                            <p className="text-xs mt-1">Start recording to see live transcription</p>
                        </>
                    )}
                </motion.div>
            ) : useVirtualization ? (
                // Virtualized rendering for large lists
                <>
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            width: "100%",
                            position: "relative",
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const segment = segments[virtualRow.index];
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <div
                                    key={segment.id}
                                    data-index={virtualRow.index}
                                    ref={virtualizer.measureElement}
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: "100%",
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        highlights={highlightsBySegment.get(virtualRow.index)}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger and loading indicator */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">Listening...</span>
                        </motion.div>
                    )}
                </>
            ) : (
                // Simple rendering for small lists (better animations)
                <>
                    <div className="space-y-1">
                        {segments.map((segment, segIndex) => {
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <motion.div
                                    key={segment.id}
                                    initial={{ opacity: 0, y: 5 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.15 }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        highlights={highlightsBySegment.get(segIndex)}
                                    />
                                </motion.div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger (for small lists that grow) */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">Listening...</span>
                        </motion.div>
                    )}
                </>
            )}
            </div>
        </div>
    );
};
