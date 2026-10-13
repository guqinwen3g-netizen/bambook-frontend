export type TTSProvider = 'browser' | 'custom';

// This service handles Text-to-Speech playback. Network synthesis must go
// through the Bambook data-center API; the renderer should not call model/TTS
// providers directly.

import { apiService } from './apiService';

export const ttsService = {
    provider: 'custom' as TTSProvider,
    authToken: '',
    customApiKey: '',
    customBaseUrl: '',

    async init() {
        this.provider = 'custom';
    },

    setProvider(p: TTSProvider, key?: string, baseUrl?: string) {
        this.provider = p;
        if (key) this.customApiKey = key;
        if (baseUrl) this.customBaseUrl = baseUrl;
    },

    setAuthToken(token?: string) {
        this.authToken = token?.trim() || '';
    },

    async speak(text: string, opts?: { voiceSpeed?: number }): Promise<void> {
        return this.speakCustom(text, opts);
    },



    async speakBrowser(text: string): Promise<void> {
        return new Promise((resolve, reject) => {
            window.speechSynthesis.cancel();

            // Ensure voices are loaded
            let voices = window.speechSynthesis.getVoices();
            if (voices.length === 0) {
                window.speechSynthesis.onvoiceschanged = () => {
                    voices = window.speechSynthesis.getVoices();
                    this._doSpeakBrowser(text, voices, resolve, reject);
                };
                // Timeout fallback
                setTimeout(() => {
                    if (window.speechSynthesis.speaking) return; // Already started
                    voices = window.speechSynthesis.getVoices();
                    this._doSpeakBrowser(text, voices, resolve, reject);
                }, 500);
            } else {
                this._doSpeakBrowser(text, voices, resolve, reject);
            }
        });
    },

    _doSpeakBrowser(text: string, voices: SpeechSynthesisVoice[], resolve: any, reject: any) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.1;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        // Target specific high-quality voices known to exist in Mac/Windows Chrome
        // "Xiaoxiao" or "Yunxi" are Edge Online voices exposed in Edge Browser.
        // "Google 普通话" is standard on Chrome.
        let targetVoice = voices.find(v => (v.name.includes("Xiaoxiao") || v.name.includes("晓晓")) && v.lang.includes("zh"));
        if (!targetVoice) {
            targetVoice = voices.find(v => (v.name.includes("Yunxi") || v.name.includes("云希")) && v.lang.includes("zh"));
        }
        if (!targetVoice) {
            targetVoice = voices.find(v => v.name.includes("Google") && v.lang.includes("zh"));
        }
        if (!targetVoice) {
            targetVoice = voices.find(v => v.lang.includes("zh-CN") || v.lang.includes("zh-HK"));
        }

        if (targetVoice) {
            console.log(`[TTS] Selected Voice: ${targetVoice.name}`);
            utterance.voice = targetVoice;
        }

        utterance.onend = () => resolve();
        utterance.onerror = (e) => resolve(); // Resolve even on error to unblock UI

        window.speechSynthesis.speak(utterance);
    },



    // [GAPLESS PLAYBACK] Web Audio API State
    _audioContext: null as AudioContext | null,
    _activeSources: [] as AudioBufferSourceNode[],
    _nextStartTime: 0,
    _streamingTextBuffer: '',
    _streamingQueue: Promise.resolve() as Promise<void>,
    _streamingAudioQueue: new Map<number, Promise<AudioBuffer>>(),
    _streamingNextSegmentId: 0,
    _streamingNextScheduleId: 0,
    _streamingFinalSegmentId: null as number | null,
    _streamingDrainPromise: null as Promise<void> | null,
    _streamingFlushTimer: null as ReturnType<typeof setTimeout> | null,
    _streamingEnded: false,
    _streamingFirstAudioStarted: false,
    _streamingAudioStartCallback: null as null | ((info: {
        segmentId: number;
        scheduledAudioContextTime: number;
        estimatedAudioStartClientAt: number;
    }) => void),
    _streamingFlushDelayMs: 900,
    _streamingFetchRetryCount: 2,
    _ttsBoundarySilenceThreshold: 0.0025,
    // 留出 20ms 静音 padding，让字头有"喘息"空间——0~5ms 太激进会把不送气的
    // 中文字头（z/c/s/sh/zh/ch + 入声字）的爬升期一并削掉，听感是"第一个字模糊"。
    _ttsBoundaryPaddingSeconds: 0.020,
    _ttsBoundaryOverlapSeconds: 0,
    // 模型自带的开头爬升其实只有 30~80ms，5ms 防点击淡入足以掩盖。
    // 之前用 _trimTtsHeadRamp 物理裁掉低响度区，会误伤所有"不送气声母 + 短入声字"
    // 的字头（中文字头能量本来就远低于韵母）→ 现在默认关掉，把决定权还给模型。
    _ttsTrimHeadRamp: false,
    _ttsHeadRampMaxSeconds: 0.10,
    _ttsHeadRampThresholdRatio: 0.35,
    // 段长策略：72 字下限避免过早切；240 字上限给古诗、长句留余地——
    // 五言绝句整首约 24 字、七言绝句约 32 字、律诗约 60~70 字，都不会被强切。
    _ttsMinChunkChars: 72,
    _ttsForceChunkChars: 240,
    _ttsShortFlushChars: 48,

    _initAudioContext() {
        if (!this._audioContext) {
            // @ts-ignore - Handle cross-browser
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            this._audioContext = new AudioContextClass();
        }
        // Always try to resume if suspended (browsers block autoplay)
        if (this._audioContext?.state === 'suspended') {
            this._audioContext.resume().catch(() => { });
        }
        return this._audioContext!;
    },

    // Flag to control playback interruption
    _isPlaying: false,
    _abortController: null as AbortController | null,

    // [AUTOPLAY POLICY] Helper to unlock logic
    async resume() {
        if (!this._audioContext) {
            this._initAudioContext();
        }
        if (this._audioContext?.state === 'suspended') {
            try {
                await this._audioContext.resume();
                console.log("[TTS] AudioContext Resumed");
            } catch (e) {
                console.warn("[TTS] Failed to resume AudioContext", e);
            }
        }
    },

    stop() {
        this._isPlaying = false;
        this._streamingTextBuffer = '';
        this._streamingQueue = Promise.resolve();
        this._streamingAudioQueue.clear();
        this._streamingNextSegmentId = 0;
        this._streamingNextScheduleId = 0;
        this._streamingFinalSegmentId = null;
        this._streamingDrainPromise = null;
        this._streamingFirstAudioStarted = false;
        this._streamingAudioStartCallback = null;
        this._clearStreamingFlushTimer();
        this._streamingEnded = false;
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }

        // Stop all Web Audio sources
        this._activeSources.forEach(source => {
            try { source.stop(); } catch (e) { }
        });
        this._activeSources = [];

        // Cancel browser native TTS
        if (typeof window !== 'undefined') {
            window.speechSynthesis?.cancel?.();
        }
    },

    // [HELPER] Clean Markdown and unnecessary symbols for TTS
    _cleanTextForTTS(text: string): string {
        return text
            .replace(/[*#`_~[\]()]/g, '') // Remove Markdown while preserving codes/dates like PO-001 or 2026-06-11.
            .replace(/\s*\n\s*/g, '，')   // Replace newlines with full-width commas
            .replace(/\s{2,}/g, ' ')      // Collapse spaces
            .trim();
    },

    // [HELPER] Split text into speakable chunks (sentences)
    _segmentText(text: string): string[] {
        const rawSegments = text.match(/[^.!?。！？\n]+[.!?。！？\n]+["']?|.+$/g);

        if (!rawSegments) return [text];

        const mergedSegments: string[] = [];
        let buffer = "";

        for (const seg of rawSegments) {
            buffer += seg;
            if (buffer.length >= this._ttsMinChunkChars) {
                mergedSegments.push(buffer);
                buffer = "";
            }
        }
        if (buffer.length > 0) {
            mergedSegments.push(buffer);
        }

        return mergedSegments;
    },

    _splitTtsSegment(segment: string): string[] {
        if (segment.length <= this._ttsForceChunkChars) return [segment];

        const chunks: string[] = [];
        let remaining = segment;
        while (remaining.length > this._ttsForceChunkChars) {
            const cut = this._findTtsChunkCut(remaining);
            chunks.push(remaining.slice(0, cut));
            remaining = remaining.slice(cut);
        }
        if (remaining) {
            chunks.push(remaining);
        }
        return chunks;
    },

    _findTtsChunkCut(text: string): number {
        const minChars = this._ttsMinChunkChars;
        const maxChars = this._ttsForceChunkChars;
        const windowText = text.slice(minChars, maxChars);
        const punctuationIndex = Math.max(
            windowText.lastIndexOf('，'),
            windowText.lastIndexOf('、'),
            windowText.lastIndexOf('；'),
            windowText.lastIndexOf('：'),
            windowText.lastIndexOf(','),
            windowText.lastIndexOf(';'),
            windowText.lastIndexOf(':'),
            windowText.lastIndexOf(' '),
        );
        return punctuationIndex >= 0 ? minChars + punctuationIndex + 1 : maxChars;
    },

    _isAudibleFrame(buffer: AudioBuffer, frame: number): boolean {
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
            if (Math.abs(buffer.getChannelData(channel)[frame] || 0) > this._ttsBoundarySilenceThreshold) {
                return true;
            }
        }
        return false;
    },

    _trimTtsBoundarySilence(buffer: AudioBuffer, ctx: AudioContext): AudioBuffer {
        if (buffer.length === 0) return buffer;

        let firstAudible = 0;
        let lastAudible = buffer.length - 1;
        while (firstAudible < buffer.length && !this._isAudibleFrame(buffer, firstAudible)) {
            firstAudible += 1;
        }
        while (lastAudible > firstAudible && !this._isAudibleFrame(buffer, lastAudible)) {
            lastAudible -= 1;
        }
        if (firstAudible === 0 && lastAudible === buffer.length - 1) return buffer;
        if (firstAudible >= buffer.length) return buffer;

        const paddingFrames = Math.floor(buffer.sampleRate * this._ttsBoundaryPaddingSeconds);
        const startFrame = Math.max(0, firstAudible - paddingFrames);
        const endFrame = Math.min(buffer.length, lastAudible + paddingFrames + 1);
        const nextLength = endFrame - startFrame;
        const minLength = Math.floor(buffer.sampleRate * 0.18);
        if (nextLength < minLength || nextLength >= buffer.length) return buffer;

        const trimmed = ctx.createBuffer(buffer.numberOfChannels, nextLength, buffer.sampleRate);
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
            trimmed.copyToChannel(buffer.getChannelData(channel).subarray(startFrame, endFrame), channel);
        }
        return trimmed;
    },

    _prepareTtsAudioBuffer(buffer: AudioBuffer, ctx: AudioContext): AudioBuffer {
        // 三步走：
        // 1) 裁掉首尾静音（thresh=0.004）
        // 2) 裁掉模型生成的"开头淡入坡"——这是导致每段开头声音弱的元凶
        // 3) 全局响度对齐（peak/RMS → baseGain），但不再加 attack 上扬曲线，否则跟模型自身淡入叠加会更乱
        const trimmedSilence = this._trimTtsBoundarySilence(buffer, ctx);
        const trimmedHead = this._ttsTrimHeadRamp
            ? this._trimTtsHeadRamp(trimmedSilence, ctx)
            : trimmedSilence;
        return this._stabilizeTtsChunkLoudness(trimmedHead, ctx);
    },

    /**
     * 裁掉每段音频开头的"低响度坡道"。
     *
     * MeloTTS 等基于声学模型的 TTS 在每个生成段开头都会有 60~120ms 的能量爬升，
     * 在分段流式播放时会被人耳感知为"每段都弱一下"。这里用滑动 RMS 找到第一个
     * 达到段稳态响度 `_ttsHeadRampThresholdRatio`（默认 55%）的位置，把之前
     * 的样本全部裁掉，保证每段一开始就在稳态响度。
     *
     * 限制：最多裁 `_ttsHeadRampMaxSeconds`（默认 180ms），避免误伤极短段。
     */
    _trimTtsHeadRamp(buffer: AudioBuffer, ctx: AudioContext): AudioBuffer {
        if (buffer.length === 0) return buffer;
        const sampleRate = buffer.sampleRate;
        const maxRampFrames = Math.min(
            buffer.length - 1,
            Math.floor(sampleRate * this._ttsHeadRampMaxSeconds)
        );
        if (maxRampFrames <= 0) return buffer;

        const windowFrames = Math.max(1, Math.floor(sampleRate * 0.02)); // 20ms 窗口

        // 1) 计算"段稳态 RMS"——跳过开头 maxRampFrames，对剩下的部分取均方根
        const probeStart = Math.min(maxRampFrames, buffer.length - 1);
        let steadySumSq = 0;
        let steadyCount = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
            const data = buffer.getChannelData(channel);
            for (let i = probeStart; i < data.length; i += 1) {
                const v = data[i] || 0;
                steadySumSq += v * v;
                steadyCount += 1;
            }
        }
        if (steadyCount === 0) return buffer;
        const steadyRms = Math.sqrt(steadySumSq / steadyCount);
        if (steadyRms <= 0) return buffer;
        const targetRms = steadyRms * this._ttsHeadRampThresholdRatio;

        // 2) 滑动窗口扫开头，找到第一个 RMS 达到 targetRms 的位置
        let cutFrame = 0;
        for (let start = 0; start <= maxRampFrames - windowFrames; start += windowFrames) {
            let sumSq = 0;
            let count = 0;
            for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
                const data = buffer.getChannelData(channel);
                for (let i = start; i < start + windowFrames && i < data.length; i += 1) {
                    const v = data[i] || 0;
                    sumSq += v * v;
                    count += 1;
                }
            }
            if (count === 0) break;
            const windowRms = Math.sqrt(sumSq / count);
            if (windowRms >= targetRms) {
                cutFrame = start;
                break;
            }
        }

        if (cutFrame <= 0) return buffer;
        // 不裁过头：留 5ms 防止 click
        const safeMargin = Math.floor(sampleRate * 0.005);
        cutFrame = Math.max(0, cutFrame - safeMargin);
        if (cutFrame === 0) return buffer;

        const newLength = buffer.length - cutFrame;
        if (newLength < Math.floor(sampleRate * 0.18)) return buffer; // 太短就放弃裁

        const trimmed = ctx.createBuffer(buffer.numberOfChannels, newLength, sampleRate);
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
            trimmed.copyToChannel(buffer.getChannelData(channel).subarray(cutFrame), channel);
        }
        return trimmed;
    },

    _stabilizeTtsChunkLoudness(buffer: AudioBuffer, ctx: AudioContext): AudioBuffer {
        if (buffer.length === 0) return buffer;

        let peak = 0;
        let sumSquares = 0;
        let samples = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
            const data = buffer.getChannelData(channel);
            for (let i = 0; i < data.length; i += 1) {
                const value = Math.abs(data[i] || 0);
                peak = Math.max(peak, value);
                sumSquares += value * value;
                samples += 1;
            }
        }
        if (peak <= 0 || samples === 0) return buffer;

        const rms = Math.sqrt(sumSquares / samples);

        // 段间响度对齐：把每段都拉到同一个 peak/RMS 目标，不再让各段"各调各的"。
        // 目标值刻意保守，避免削顶；夹紧到 [0.85, 1.6] 的合理增益区间。
        const TARGET_PEAK = 0.78;
        const TARGET_RMS = 0.14;
        const peakGain = TARGET_PEAK / peak;
        const rmsGain = rms > 0 ? TARGET_RMS / rms : peakGain;
        const baseGain = Math.max(0.85, Math.min(1.6, Math.min(peakGain, rmsGain)));
        if (Math.abs(baseGain - 1) <= 0.02) return buffer;

        const output = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
        const headroom = 0.96;
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
            const input = buffer.getChannelData(channel);
            const data = output.getChannelData(channel);
            for (let i = 0; i < input.length; i += 1) {
                const value = input[i] * baseGain;
                data[i] = Math.max(-headroom, Math.min(headroom, value));
            }
        }
        return output;
    },

    _getTtsBoundaryOverlap(buffer: AudioBuffer): number {
        if (buffer.duration <= 0.4) return 0;
        return Math.min(this._ttsBoundaryOverlapSeconds, buffer.duration * 0.18);
    },

    beginStreaming(opts?: { voiceSpeed?: number }) {
        this.stop();
        this._isPlaying = true;
        this._streamingEnded = false;
        this._streamingTextBuffer = '';
        this._streamingQueue = Promise.resolve();
        this._streamingAudioQueue.clear();
        this._streamingNextSegmentId = 0;
        this._streamingNextScheduleId = 0;
        this._streamingFinalSegmentId = null;
        this._streamingDrainPromise = null;
        this._clearStreamingFlushTimer();
        this._abortController = new AbortController();
        const ctx = this._initAudioContext();
        this._nextStartTime = ctx.currentTime + 0.05;
        this._streamingVoiceSpeed = opts?.voiceSpeed ?? 1;
    },

    beginBackendStreaming(opts?: {
        onAudioStart?: (info: {
            segmentId: number;
            scheduledAudioContextTime: number;
            estimatedAudioStartClientAt: number;
        }) => void
    }) {
        this.stop();
        this._isPlaying = true;
        this._streamingEnded = false;
        this._streamingTextBuffer = '';
        this._streamingQueue = Promise.resolve();
        this._streamingAudioQueue.clear();
        this._streamingNextSegmentId = 0;
        this._streamingNextScheduleId = 0;
        this._streamingFinalSegmentId = null;
        this._streamingDrainPromise = null;
        this._streamingFirstAudioStarted = false;
        this._streamingAudioStartCallback = opts?.onAudioStart || null;
        this._clearStreamingFlushTimer();
        this._abortController = new AbortController();
        const ctx = this._initAudioContext();
        this._nextStartTime = ctx.currentTime + 0.05;
    },

    enqueueBackendAudioChunk(chunk: { segmentId: number; audioBase64: string; contentType?: string }) {
        if (!this._isPlaying || this._streamingEnded || this._abortController?.signal.aborted) return;
        if (!Number.isInteger(chunk.segmentId) || chunk.segmentId < 0 || !chunk.audioBase64) return;
        const audioPromise = this._decodeTtsAudioBase64(chunk.audioBase64);
        this._streamingAudioQueue.set(chunk.segmentId, audioPromise);
        this._streamingNextSegmentId = Math.max(this._streamingNextSegmentId, chunk.segmentId + 1);
        this._drainStreamingPlaybackQueue();
    },

    endBackendStreaming() {
        if (!this._isPlaying) return;
        this._streamingEnded = true;
        this._clearStreamingFlushTimer();
        this._streamingFinalSegmentId = this._streamingNextSegmentId - 1;
        this._drainStreamingPlaybackQueue();
        this._streamingQueue = (this._streamingDrainPromise || this._streamingQueue).finally(() => {
            this._maybeFinishStreamingPlayback();
        });
    },

    appendStreamingText(text: string) {
        if (!this._isPlaying || this._streamingEnded || !text) return;
        this._streamingTextBuffer += text;
        const segments = this._takeReadyStreamingSegments(false);
        segments.forEach(segment => this._enqueueStreamingSegment(segment));
        if (this._streamingTextBuffer) {
            this._scheduleStreamingFlush();
        } else {
            this._clearStreamingFlushTimer();
        }
    },

    endStreaming() {
        if (!this._isPlaying) return;
        this._streamingEnded = true;
        this._clearStreamingFlushTimer();
        const segments = this._takeReadyStreamingSegments(true);
        segments.forEach(segment => this._enqueueStreamingSegment(segment));
        this._streamingFinalSegmentId = this._streamingNextSegmentId - 1;
        this._drainStreamingPlaybackQueue();
        this._streamingQueue = (this._streamingDrainPromise || this._streamingQueue).finally(() => {
            this._maybeFinishStreamingPlayback();
        });
    },

    _streamingVoiceSpeed: 1,

    _clearStreamingFlushTimer() {
        if (this._streamingFlushTimer) {
            clearTimeout(this._streamingFlushTimer);
            this._streamingFlushTimer = null;
        }
    },

    _scheduleStreamingFlush() {
        if (this._streamingEnded || this._streamingFlushTimer) return;
        this._streamingFlushTimer = setTimeout(() => {
            this._streamingFlushTimer = null;
            this._flushStreamingBufferForLatency();
        }, this._streamingFlushDelayMs);
    },

    _flushStreamingBufferForLatency() {
        if (!this._isPlaying || this._streamingEnded) return;
        const clean = this._cleanTextForTTS(this._streamingTextBuffer);
        if (clean.length < this._ttsShortFlushChars) {
            if (clean) this._scheduleStreamingFlush();
            return;
        }
        this._streamingTextBuffer = '';
        this._enqueueStreamingSegment(clean);
    },

    _takeReadyStreamingSegments(flush: boolean): string[] {
        const clean = this._cleanTextForTTS(this._streamingTextBuffer);
        if (!clean) {
            this._streamingTextBuffer = '';
            return [];
        }

        const segments: string[] = [];
        let cursor = 0;
        const boundaryPattern = /[。！？.!?]/g;
        let match: RegExpExecArray | null;
        while ((match = boundaryPattern.exec(clean)) !== null) {
            const end = match.index + match[0].length;
            const candidate = clean.slice(cursor, end).trim();
            if (candidate.length >= this._ttsMinChunkChars) {
                segments.push(candidate);
                cursor = end;
            }
        }

        const remaining = clean.slice(cursor).trim();
        if (!flush && remaining.length >= this._ttsForceChunkChars) {
            const cut = this._findTtsChunkCut(remaining);
            segments.push(remaining.slice(0, cut).trim());
            this._streamingTextBuffer = remaining.slice(cut).trim();
            return segments.filter(Boolean);
        }

        if (flush && remaining) {
            segments.push(remaining);
            this._streamingTextBuffer = '';
        } else {
            this._streamingTextBuffer = remaining;
        }
        return segments.filter(Boolean);
    },

    _enqueueStreamingSegment(segment: string) {
        const text = this._cleanTextForTTS(segment);
        if (!text) return;
        if (!this._abortController || this._abortController.signal.aborted) return;
        const segmentId = this._streamingNextSegmentId;
        this._streamingNextSegmentId += 1;
        const audioPromise = this._fetchTtsAudioWithRetry(text, this._streamingVoiceSpeed, this._abortController.signal);
        this._streamingAudioQueue.set(segmentId, audioPromise);
        this._drainStreamingPlaybackQueue();
    },

    async _fetchTtsAudioWithRetry(segment: string, voiceSpeed: number, signal: AbortSignal): Promise<AudioBuffer> {
        let lastError: unknown;
        for (let attempt = 0; attempt <= this._streamingFetchRetryCount; attempt += 1) {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            try {
                return await this._fetchTtsAudio(segment, voiceSpeed, signal);
            } catch (error: any) {
                lastError = error;
                if (signal.aborted || error?.name === 'AbortError' || error?.message === 'Aborted') throw error;
                if (attempt < this._streamingFetchRetryCount) {
                    await new Promise(resolve => setTimeout(resolve, 120 * (attempt + 1)));
                }
            }
        }
        throw lastError instanceof Error ? lastError : new Error('TTS streaming chunk failed');
    },

    _drainStreamingPlaybackQueue() {
        if (this._streamingDrainPromise) return;
        this._streamingDrainPromise = (async () => {
            while (this._isPlaying && !this._abortController?.signal.aborted) {
                const segmentId = this._streamingNextScheduleId;
                const audioPromise = this._streamingAudioQueue.get(segmentId);
                if (!audioPromise) break;
                this._streamingAudioQueue.delete(segmentId);
                this._streamingNextScheduleId += 1;
                try {
                    const ctx = this._initAudioContext();
                    const audioBuffer = await audioPromise;
                    if (!this._isPlaying || this._abortController?.signal.aborted) return;
                    await this.resume();
                    const scheduledAudioContextTime = this._scheduleAudioBuffer(audioBuffer, ctx, false);
                    if (!this._streamingFirstAudioStarted) {
                        this._streamingFirstAudioStarted = true;
                        const startDelayMs = Math.max(0, scheduledAudioContextTime - ctx.currentTime) * 1000;
                        this._streamingAudioStartCallback?.({
                            segmentId,
                            scheduledAudioContextTime,
                            estimatedAudioStartClientAt: performance.now() + startDelayMs,
                        });
                    }
                } catch (error: any) {
                    if (error?.name !== 'AbortError' && error?.message !== 'Aborted') {
                        console.error('TTS Streaming Chunk Error', error);
                    }
                }
            }
        })().finally(() => {
            this._streamingDrainPromise = null;
            this._maybeFinishStreamingPlayback();
            if (this._streamingAudioQueue.has(this._streamingNextScheduleId)) {
                this._drainStreamingPlaybackQueue();
            }
        });
        this._streamingQueue = this._streamingDrainPromise;
    },

    _maybeFinishStreamingPlayback() {
        if (
            this._streamingEnded &&
            this._streamingFinalSegmentId !== null &&
            this._streamingNextScheduleId > this._streamingFinalSegmentId &&
            this._streamingAudioQueue.size === 0 &&
            this._activeSources.length === 0
        ) {
            this._isPlaying = false;
        }
    },

    async _fetchTtsAudio(segment: string, voiceSpeed: number, signal: AbortSignal): Promise<AudioBuffer> {
        const customUrl = this.customBaseUrl;
        if (!customUrl) throw new Error('Bambook TTS endpoint is not configured');
        const ctx = this._initAudioContext();
        const pct = Math.round((voiceSpeed - 1) * 100);
        const rateStr = `${pct >= 0 ? '+' : ''}${pct}%`;
        const response = await fetch(customUrl, {
            method: 'POST',
            // 统一认证头：Content-Type + API key + 登录会话 JWT（与 apiService 同口径）
            headers: apiService.getAuthHeaders(),
            credentials: 'include',
            body: JSON.stringify({
                input: segment,
                voice: 'default',
                model: 'melo',
                rate: rateStr,
                response_format: 'wav'
            }),
            signal
        });
        if (!response.ok) throw new Error(`Status: ${response.statusText}`);
        const decoded = await ctx.decodeAudioData(await response.arrayBuffer());
        return this._prepareTtsAudioBuffer(decoded, ctx);
    },

    async _decodeTtsAudioBase64(audioBase64: string): Promise<AudioBuffer> {
        const ctx = this._initAudioContext();
        const binary = atob(audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        const decoded = await ctx.decodeAudioData(bytes.buffer);
        return this._prepareTtsAudioBuffer(decoded, ctx);
    },

    _scheduleAudioBuffer(audioBuffer: AudioBuffer, ctx: AudioContext, isLast: boolean) {
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        const gain = ctx.createGain();
        const scheduleTime = Math.max(ctx.currentTime, this._nextStartTime);
        // 极短防点击淡入（5ms）：仅用于消除硬切产生的 click，不做美学上的 fade-in。
        // 这样既不会让段头响度下降（导致"每段开头声音弱"），又能避免相邻段拼接时的爆音。
        const clickGuardSec = 0.005;
        gain.gain.setValueAtTime(0.001, scheduleTime);
        gain.gain.exponentialRampToValueAtTime(1.0, scheduleTime + clickGuardSec);
        source.connect(gain);
        if (typeof ctx.createDynamicsCompressor === 'function') {
            const compressor = ctx.createDynamicsCompressor();
            compressor.threshold.setValueAtTime(-26, ctx.currentTime);
            compressor.knee.setValueAtTime(24, ctx.currentTime);
            compressor.ratio.setValueAtTime(3, ctx.currentTime);
            compressor.attack.setValueAtTime(0.003, ctx.currentTime);
            compressor.release.setValueAtTime(0.18, ctx.currentTime);
            gain.connect(compressor);
            compressor.connect(ctx.destination);
        } else {
            gain.connect(ctx.destination);
        }
        this._activeSources.push(source);
        source.onended = () => {
            const index = this._activeSources.indexOf(source);
            if (index > -1) this._activeSources.splice(index, 1);
            if (isLast) this._isPlaying = false;
            this._maybeFinishStreamingPlayback();
        };

        source.start(scheduleTime);
        const overlap = this._getTtsBoundaryOverlap(audioBuffer);
        this._nextStartTime = scheduleTime + Math.max(0.01, audioBuffer.duration - overlap);
        return scheduleTime;
    },

    async speakCustom(text: string, opts?: { voiceSpeed?: number }): Promise<void> {
        // Safety: prevent duplicate greeting if it's from strict mode re-renders
        if (this._isPlaying && (text.includes("风吟竹衍") || text.includes("神经链接"))) {
            console.log("[TTS] Skipping duplicate greeting playback request");
            return;
        }

        // [OPTIMIZATION REMOVED] Dynamic greeting required for "竹衍" persona.
        // We will now always synthesize the text to ensure the audio matches the latest script.


        // 1. Reset State
        this.stop();
        this._isPlaying = true;
        this._abortController = new AbortController();
        const ctx = this._initAudioContext();

        // 2. Prepare text
        const cleanText = this._cleanTextForTTS(text);
        const customUrl = this.customBaseUrl;
        if (!customUrl) {
            throw new Error('Bambook TTS endpoint is not configured');
        }
        const signal = this._abortController.signal;
        const speed = opts?.voiceSpeed ?? 1;
        const pct = Math.round((speed - 1) * 100);
        const rateStr = `${pct >= 0 ? '+' : ''}${pct}%`;

        if (!cleanText) return;

        const chunks = this._segmentText(cleanText);
        console.log(`[TTS] Requesting Bambook TTS: ${chunks.length} chunks`);
        this._nextStartTime = ctx.currentTime + 0.05;

        const fetchAudio = async (segment: string): Promise<AudioBuffer> => this._fetchTtsAudio(segment, speed, signal);

        const windowSize = 4;
        const pending = new Map<number, Promise<AudioBuffer>>();
        const enqueue = (index: number) => {
            if (index < chunks.length && !pending.has(index)) {
                pending.set(index, fetchAudio(chunks[index]));
            }
        };
        for (let i = 0; i < Math.min(windowSize, chunks.length); i++) enqueue(i);

        for (let i = 0; i < chunks.length; i++) {
            if (!this._isPlaying || signal.aborted) break;
            try {
                const audioBuffer = await pending.get(i)!;
                pending.delete(i);
                enqueue(i + windowSize);
                if (!this._isPlaying || signal.aborted) break;

                await this.resume();
                this._scheduleAudioBuffer(audioBuffer, ctx, i === chunks.length - 1);
            } catch (e: any) {
                if (e.name !== 'AbortError' && e.message !== 'Aborted') {
                    console.error("TTS Chunk Error", e);
                }
            }
        }
    },

    /**
     * Helper to play a static audio file (mp3/wav) using the Web Audio API.
     * Used for zero-latency UI sounds or cached greetings.
     */
    async _playStaticAudio(url: string): Promise<void> {
        this.stop();
        this._isPlaying = true;
        const ctx = this._initAudioContext();

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error("File not found");
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);

            this._activeSources.push(source);
            source.onended = () => {
                const index = this._activeSources.indexOf(source);
                if (index > -1) this._activeSources.splice(index, 1);
                this._isPlaying = false;
            };
            source.start(0);
        } catch (e) {
            console.error("Static Playback Failed", e);
            this._isPlaying = false;
            throw e;
        }
    },

    // Legacy placeholder to prevent strict mode errors if needed
    _legacy_end: null

};
