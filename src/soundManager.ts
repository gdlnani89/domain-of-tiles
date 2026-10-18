/**
 * SoundManager - Sistema de Áudio Procedural para RTS via Web Audio API
 * Sintetiza todos os efeitos sonoros em tempo real com osciladores e ruído filtrado (sem arquivos externos).
 */

class SoundManager {
  public ctx: AudioContext | null = null;
  public masterGain: GainNode | null = null;
  public isMuted: boolean = false;
  private noiseBuffer: AudioBuffer | null = null;
  private lastPlayTimes: Record<string, number> = {};

  constructor() {
    // Carrega preferência persistente de mudo
    try {
      const saved = localStorage.getItem('rts_sound_muted');
      if (saved !== null) {
        this.isMuted = saved === 'true';
      } else {
        this.isMuted = false;
      }
    } catch {
      this.isMuted = false;
    }
  }

  /**
   * Garante que o AudioContext seja instanciado e desbloqueado após o primeiro clique do usuário
   */
  public ensureAudioContext(): AudioContext | null {
    if (!this.ctx) {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtxClass) return null;
      this.ctx = new AudioCtxClass();

      this.masterGain = this.ctx.createGain();
      const currentVol = this.isMuted ? 0 : 0.75;
      this.masterGain.gain.setValueAtTime(currentVol, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);
    } else if (!this.masterGain) {
      this.masterGain = this.ctx.createGain();
      const currentVol = this.isMuted ? 0 : 0.75;
      this.masterGain.gain.setValueAtTime(currentVol, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);
    }

    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    // Garante que o ganho mestre esteja com volume audível se não estiver mutado
    if (!this.isMuted && this.masterGain && this.masterGain.gain.value === 0) {
      this.masterGain.gain.setValueAtTime(0.75, this.ctx.currentTime);
    }

    return this.ctx;
  }

  public initContext(): AudioContext | null {
    return this.ensureAudioContext();
  }

  public getIsMuted(): boolean {
    return this.isMuted;
  }

  public toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    try {
      localStorage.setItem('rts_sound_muted', String(this.isMuted));
    } catch {}

    if (this.ctx && this.masterGain) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.linearRampToValueAtTime(this.isMuted ? 0 : 0.75, now + 0.05);
    }

    // Se estiver desmutando e o contexto ainda não iniciou, inicializa
    if (!this.isMuted) {
      this.ensureAudioContext();
      this.uiClick();
    }

    return this.isMuted;
  }

  public setMuted(muted: boolean): void {
    if (this.isMuted === muted) return;
    this.toggleMute();
  }

  private throttle(key: string, minIntervalMs: number): boolean {
    const now = performance.now();
    const last = this.lastPlayTimes[key] || 0;
    if (now - last < minIntervalMs) {
      return false;
    }
    this.lastPlayTimes[key] = now;
    return true;
  }

  private getNoise(ctx: AudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      const size = ctx.sampleRate;
      this.noiseBuffer = ctx.createBuffer(1, size, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < size; i++) {
        data[i] = Math.random() * 2 - 1;
      }
    }
    return this.noiseBuffer;
  }

  // =========================================================================
  // GERADORES DE EFEITOS SONOROS SINTETIZADOS
  // =========================================================================

  /**
   * uiClick: Bipe suave e nítido de alta frequência para cliques de botões
   */
  public uiClick(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('uiClick', 40)) return;

    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(950, t);
    osc.frequency.exponentialRampToValueAtTime(580, t + 0.04);

    gain.gain.setValueAtTime(0.16, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(t);
    osc.stop(t + 0.045);
  }

  /**
   * orderMove: Tom duplo metálico/tático para comando de marcha com botão direito
   */
  public orderMove(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('orderMove', 90)) return;

    const t = ctx.currentTime;

    // Primeiro pulso tático (520Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(520, t);
    gain1.gain.setValueAtTime(0.18, t);
    gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc1.connect(gain1);
    gain1.connect(this.masterGain);
    osc1.start(t);
    osc1.stop(t + 0.055);

    // Segundo pulso harmônico agudo (720Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(720, t + 0.055);
    gain2.gain.setValueAtTime(0.001, t);
    gain2.gain.setValueAtTime(0.22, t + 0.055);
    gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc2.connect(gain2);
    gain2.connect(this.masterGain);
    osc2.start(t + 0.055);
    osc2.stop(t + 0.13);
  }

  /**
   * rallyPointSet: Som sutil de confirmação tática para definição de Ponto de Encontro
   */
  public rallyPointSet(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('rallyPointSet', 80)) return;

    const t = ctx.currentTime;

    // Primeiro tom tático claro e suave (580Hz -> 740Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(580, t);
    osc1.frequency.exponentialRampToValueAtTime(740, t + 0.05);
    gain1.gain.setValueAtTime(0.18, t);
    gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc1.connect(gain1);
    gain1.connect(this.masterGain);
    osc1.start(t);
    osc1.stop(t + 0.065);

    // Segundo tom agudo de confirmação (880Hz -> 1050Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(880, t + 0.06);
    osc2.frequency.exponentialRampToValueAtTime(1050, t + 0.12);
    gain2.gain.setValueAtTime(0.001, t);
    gain2.gain.setValueAtTime(0.20, t + 0.06);
    gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc2.connect(gain2);
    gain2.connect(this.masterGain);
    osc2.start(t + 0.06);
    osc2.stop(t + 0.16);
  }

  public playRallyPointSet(): void {
    this.rallyPointSet();
  }

  /**
   * chopWood: Ruído percussivo curto (noise + lowpass filter) ritmado simulando machado na árvore
   */
  public chopWood(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('chopWood', 100)) return;

    const t = ctx.currentTime;

    // 1. Ruído filtrado do impacto da lâmina de ferro na madeira
    const noise = ctx.createBufferSource();
    noise.buffer = this.getNoise(ctx);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(480, t);
    filter.Q.setValueAtTime(2.2, t);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.38, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);

    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(this.masterGain);

    noise.start(t);
    noise.stop(t + 0.075);

    // 2. Batida de ressonância do tronco (tom grave descendente)
    const thud = ctx.createOscillator();
    const thudGain = ctx.createGain();
    thud.type = 'triangle';
    thud.frequency.setValueAtTime(150, t);
    thud.frequency.exponentialRampToValueAtTime(45, t + 0.07);

    thudGain.gain.setValueAtTime(0.32, t);
    thudGain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);

    thud.connect(thudGain);
    thudGain.connect(this.masterGain);

    thud.start(t);
    thud.stop(t + 0.075);
  }

  /**
   * forageFood: Som suave e rústico de folhagem/arbusto sendo colhido
   */
  public forageFood(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('forageFood', 110)) return;

    const t = ctx.currentTime;

    const noise = ctx.createBufferSource();
    noise.buffer = this.getNoise(ctx);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1600, t);
    filter.frequency.linearRampToValueAtTime(1100, t + 0.12);
    filter.Q.setValueAtTime(1.8, t);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.01, t);
    gain.gain.linearRampToValueAtTime(0.24, t + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    noise.start(t);
    noise.stop(t + 0.14);
  }

  /**
   * farmHarvest: Som suave de foice e palha colhendo trigo da fazenda
   */
  public farmHarvest(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('farmHarvest', 110)) return;

    const t = ctx.currentTime;

    const noise = ctx.createBufferSource();
    noise.buffer = this.getNoise(ctx);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    // Movimento suave de ceifar o trigo (sweep 700Hz -> 1800Hz -> 900Hz)
    filter.frequency.setValueAtTime(750, t);
    filter.frequency.linearRampToValueAtTime(1850, t + 0.05);
    filter.frequency.linearRampToValueAtTime(800, t + 0.12);
    filter.Q.setValueAtTime(2.2, t);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.01, t);
    gain.gain.linearRampToValueAtTime(0.26, t + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);

    noise.start(t);
    noise.stop(t + 0.14);
  }

  /**
   * mineStone: Clique metálico seco de picareta contra rocha com ressonância alta
   */
  public mineStone(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('mineStone', 95)) return;

    const t = ctx.currentTime;

    // 1. Estalo inicial de atrito do ferro contra pedra
    const noise = ctx.createBufferSource();
    noise.buffer = this.getNoise(ctx);
    const nFilter = ctx.createBiquadFilter();
    nFilter.type = 'highpass';
    nFilter.frequency.setValueAtTime(2200, t);
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.3, t);
    nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
    noise.connect(nFilter);
    nFilter.connect(nGain);
    nGain.connect(this.masterGain);
    noise.start(t);
    noise.stop(t + 0.04);

    // 2. Ressonância metálica seca da lâmina da picareta
    const osc1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(1420, t);
    g1.gain.setValueAtTime(0.24, t);
    g1.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc1.connect(g1);
    g1.connect(this.masterGain);
    osc1.start(t);
    osc1.stop(t + 0.085);

    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(2360, t);
    g2.gain.setValueAtTime(0.18, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.065);
    osc2.connect(g2);
    g2.connect(this.masterGain);
    osc2.start(t);
    osc2.stop(t + 0.07);
  }

  /**
   * mineGold: Tilintar brilhante com harmônicos metálicos para o garimpo de ouro
   */
  public mineGold(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('mineGold', 90)) return;

    const t = ctx.currentTime;

    // Harmônicos brilhantes de sino/ouro puro
    const freqs = [1980, 3140, 4820];
    const gains = [0.22, 0.16, 0.11];

    freqs.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * 0.98, t + 0.2);

      g.gain.setValueAtTime(gains[idx], t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);

      osc.connect(g);
      g.connect(this.masterGain!);

      osc.start(t);
      osc.stop(t + 0.23);
    });
  }

  /**
   * swordClash: Rajada curta de ruído branco filtrado com tom descendente agudo para golpes de espada
   */
  public swordClash(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('swordClash', 80)) return;

    const t = ctx.currentTime;

    // 1. Rajada de ruído branco cortante com filtro ressonante agudo
    const noise = ctx.createBufferSource();
    noise.buffer = this.getNoise(ctx);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(3400, t);
    filter.frequency.exponentialRampToValueAtTime(850, t + 0.08);
    filter.Q.setValueAtTime(6.5, t);

    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.42, t);
    nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);

    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(this.masterGain);

    noise.start(t);
    noise.stop(t + 0.095);

    // 2. Tilintar agudo de lâmina de aço temperado
    const steel = ctx.createOscillator();
    const sGain = ctx.createGain();
    steel.type = 'triangle';
    steel.frequency.setValueAtTime(1860, t);
    steel.frequency.exponentialRampToValueAtTime(1420, t + 0.14);

    sGain.gain.setValueAtTime(0.24, t);
    sGain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);

    steel.connect(sGain);
    sGain.connect(this.masterGain);

    steel.start(t);
    steel.stop(t + 0.15);
  }

  /**
   * buildingComplete: Acorde triádico triunfante em arpejo curto quando um edifício finaliza
   */
  public buildingComplete(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('buildingComplete', 300)) return;

    const t = ctx.currentTime;

    // Arpejo Maior Medieval: Dó5 (523Hz), Mi5 (659Hz), Sol5 (784Hz), Dó6 (1046Hz)
    const notes = [523.25, 659.25, 783.99, 1046.5];
    const noteDelay = 0.065;
    const noteDuration = 0.42;

    notes.forEach((freq, idx) => {
      const start = t + idx * noteDelay;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = idx === notes.length - 1 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(freq, start);

      const peakGain = idx === notes.length - 1 ? 0.28 : 0.22;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(peakGain, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + noteDuration);

      osc.connect(gain);
      gain.connect(this.masterGain!);

      osc.start(start);
      osc.stop(start + noteDuration + 0.02);
    });
  }

  /**
   * updateNotification: Notificação sonora amigável para alertas de auto-update
   */
  public updateNotification(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    const t = ctx.currentTime;
    const notes = [587.33, 880.0]; // D5 -> A5
    notes.forEach((freq, idx) => {
      const start = t + idx * 0.12;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.24, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
      osc.connect(gain);
      gain.connect(this.masterGain!);
      osc.start(start);
      osc.stop(start + 0.38);
    });
  }

  /**
   * alertAttack: Toque de buzina de guerra ou sino grave quando tropas aliadas são atacadas
   */
  public alertAttack(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('alertAttack', 3500)) return;

    const t = ctx.currentTime;

    // 1. Buzina de guerra grave (Sawtooth com passa-baixas)
    const horn = ctx.createOscillator();
    const hFilter = ctx.createBiquadFilter();
    const hGain = ctx.createGain();

    horn.type = 'sawtooth';
    horn.frequency.setValueAtTime(155, t);
    horn.frequency.linearRampToValueAtTime(185, t + 0.12);
    horn.frequency.linearRampToValueAtTime(160, t + 0.45);

    hFilter.type = 'lowpass';
    hFilter.frequency.setValueAtTime(420, t);
    hFilter.Q.setValueAtTime(2.0, t);

    hGain.gain.setValueAtTime(0.01, t);
    hGain.gain.linearRampToValueAtTime(0.35, t + 0.04);
    hGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);

    horn.connect(hFilter);
    hFilter.connect(hGain);
    hGain.connect(this.masterGain);

    horn.start(t);
    horn.stop(t + 0.52);

    // 2. Sino de alerta grave (880Hz -> ressonância de sino)
    const chime = ctx.createOscillator();
    const cGain = ctx.createGain();
    chime.type = 'sine';
    chime.frequency.setValueAtTime(880, t);
    cGain.gain.setValueAtTime(0.2, t);
    cGain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);

    chime.connect(cGain);
    cGain.connect(this.masterGain);

    chime.start(t);
    chime.stop(t + 0.62);
  }

  /**
   * popCappedAlert: Bip duplo grave de aviso quando a população atinge o limite
   */
  public popCappedAlert(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('popCappedAlert', 500)) return;

    const t = ctx.currentTime;

    // Primeiro bip grave (260Hz)
    const osc1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(260, t);
    const filter1 = ctx.createBiquadFilter();
    filter1.type = 'lowpass';
    filter1.frequency.setValueAtTime(650, t);

    g1.gain.setValueAtTime(0.24, t);
    g1.gain.exponentialRampToValueAtTime(0.001, t + 0.07);

    osc1.connect(filter1);
    filter1.connect(g1);
    g1.connect(this.masterGain);

    osc1.start(t);
    osc1.stop(t + 0.075);

    // Segundo bip grave descendente (210Hz)
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(210, t + 0.09);
    const filter2 = ctx.createBiquadFilter();
    filter2.type = 'lowpass';
    filter2.frequency.setValueAtTime(650, t + 0.09);

    g2.gain.setValueAtTime(0.001, t);
    g2.gain.setValueAtTime(0.24, t + 0.09);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.17);

    osc2.connect(filter2);
    filter2.connect(g2);
    g2.connect(this.masterGain);

    osc2.start(t + 0.09);
    osc2.stop(t + 0.18);
  }

  /**
   * warTrumpetAlert / trumpetAlert: Toque triunfal e dramático de trombeta/clarim de guerra medieval
   * Disparado quando ondas inimigas de invasão marcham contra a base do jogador.
   */
  public warTrumpetAlert(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('warTrumpetAlert', 3000)) return;

    const t = ctx.currentTime;

    // Fanfarra marcial medieval de 4 notas ascendentes: E4 (329.6), A4 (440.0), C#5 (554.4), E5 (659.3)
    const notes = [
      { freq: 329.63, start: 0.00, dur: 0.13, gain: 0.28 },
      { freq: 440.00, start: 0.14, dur: 0.13, gain: 0.32 },
      { freq: 554.37, start: 0.28, dur: 0.18, gain: 0.36 },
      { freq: 659.25, start: 0.48, dur: 0.85, gain: 0.40 }
    ];

    notes.forEach((n, idx) => {
      const noteTime = t + n.start;
      const isLast = idx === notes.length - 1;

      // 1. Oscilador Primário de Latão (Sawtooth rico em harmônicos)
      const oscSaw = ctx.createOscillator();
      oscSaw.type = 'sawtooth';
      oscSaw.frequency.setValueAtTime(n.freq, noteTime);

      // 2. Oscilador Secundário levemente desafinado para corpo encorpado de naipe de metais
      const oscDetune = ctx.createOscillator();
      oscDetune.type = 'triangle';
      oscDetune.frequency.setValueAtTime(n.freq * 1.004, noteTime);

      if (isLast) {
        // Vibrato no final da nota sustentada
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.frequency.setValueAtTime(5.5, noteTime + 0.2);
        lfoGain.gain.setValueAtTime(5.0, noteTime + 0.2);
        lfo.connect(oscSaw.frequency);
        lfo.connect(oscDetune.frequency);
        lfo.start(noteTime + 0.2);
        lfo.stop(noteTime + n.dur);
      }

      // Filtro de campana de metal (Biquad Bandpass + ressonância metálica)
      const brassFilter = ctx.createBiquadFilter();
      brassFilter.type = 'lowpass';
      brassFilter.frequency.setValueAtTime(isLast ? 2200 : 1800, noteTime);
      brassFilter.Q.setValueAtTime(2.2, noteTime);

      // Envelope de ganho com ataque rápido característico de sopro de trompete
      const noteGain = ctx.createGain();
      noteGain.gain.setValueAtTime(0.001, noteTime);
      noteGain.gain.linearRampToValueAtTime(n.gain, noteTime + 0.02);
      noteGain.gain.exponentialRampToValueAtTime(0.001, noteTime + n.dur);

      oscSaw.connect(brassFilter);
      oscDetune.connect(brassFilter);
      brassFilter.connect(noteGain);
      noteGain.connect(this.masterGain!);

      oscSaw.start(noteTime);
      oscSaw.stop(noteTime + n.dur + 0.02);
      oscDetune.start(noteTime);
      oscDetune.stop(noteTime + n.dur + 0.02);
    });

    // Sub-grave de apoio marcial (bumbo distante na nota final)
    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(110, t + 0.48);
    subOsc.frequency.exponentialRampToValueAtTime(55, t + 0.48 + 0.6);
    subGain.gain.setValueAtTime(0.001, t + 0.48);
    subGain.gain.linearRampToValueAtTime(0.3, t + 0.48 + 0.03);
    subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.48 + 0.7);

    subOsc.connect(subGain);
    subGain.connect(this.masterGain);
    subOsc.start(t + 0.48);
    subOsc.stop(t + 0.48 + 0.75);
  }

  public trumpetAlert(): void {
    this.warTrumpetAlert();
  }

  /**
   * bowShoot: Disparo de flecha balística com vibração de corda de arco (twang) e sibilo de ar (whoosh)
   */
  public bowShoot(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('bowShoot', 60)) return;

    const t = ctx.currentTime;

    // 1. Vibração elástica e rápida da corda esticada (twang)
    const twang = ctx.createOscillator();
    const twangGain = ctx.createGain();
    twang.type = 'triangle';
    twang.frequency.setValueAtTime(580, t);
    twang.frequency.exponentialRampToValueAtTime(220, t + 0.08);

    twangGain.gain.setValueAtTime(0.35, t);
    twangGain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);

    twang.connect(twangGain);
    twangGain.connect(this.masterGain);
    twang.start(t);
    twang.stop(t + 0.11);

    // 2. Sibilo do corte do vento (whoosh do projétil)
    const noise = ctx.createBufferSource();
    noise.buffer = this.getNoise(ctx);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2200, t);
    filter.frequency.exponentialRampToValueAtTime(1200, t + 0.12);
    filter.Q.setValueAtTime(4.0, t);

    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.28, t);
    nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);

    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(this.masterGain);

    noise.start(t);
    noise.stop(t + 0.14);
  }

  /**
   * arrowHit: Impacto contundente da ponta da flecha no alvo
   */
  public arrowHit(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('arrowHit', 50)) return;

    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const oGain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(280, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.07);

    oGain.gain.setValueAtTime(0.35, t);
    oGain.gain.exponentialRampToValueAtTime(0.001, t + 0.075);

    osc.connect(oGain);
    oGain.connect(this.masterGain);

    osc.start(t);
    osc.stop(t + 0.08);
  }

  /**
   * hammer: Som de martelada/construção e reparo de estruturas
   */
  public hammer(): void {
    this.ensureAudioContext();
    if (this.isMuted) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterGain) return;
    if (!this.throttle('hammer', 180)) return;

    const t = ctx.currentTime;

    // 1. Clink metálico agudo do martelo atingindo a estrutura
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1400, t);
    osc.frequency.exponentialRampToValueAtTime(700, t + 0.08);

    oscGain.gain.setValueAtTime(0.25, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);

    osc.connect(oscGain);
    oscGain.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.09);

    // 2. Impacto surdo da madeira/pedra
    const thud = ctx.createOscillator();
    const thudGain = ctx.createGain();
    thud.type = 'triangle';
    thud.frequency.setValueAtTime(220, t);
    thud.frequency.exponentialRampToValueAtTime(80, t + 0.12);

    thudGain.gain.setValueAtTime(0.35, t);
    thudGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    thud.connect(thudGain);
    thudGain.connect(this.masterGain);
    thud.start(t);
    thud.stop(t + 0.13);
  }

  // Métodos utilitários e aliases convenientes
  public playWoodChop(): void {
    this.chopWood();
  }

  public playHammer(): void {
    this.hammer();
  }

  public playBowShoot(): void {
    this.bowShoot();
  }

  public playArrowHit(): void {
    this.arrowHit();
  }

  public playUiClick(): void {
    this.uiClick();
  }

  public playOrderMove(): void {
    this.orderMove();
  }

  public playBuildingComplete(): void {
    this.buildingComplete();
  }

  public playSwordClash(): void {
    this.swordClash();
  }

  public playSwordHit(): void {
    this.swordClash();
  }

  public playAlertAttack(): void {
    this.alertAttack();
  }

  public playWarTrumpetAlert(): void {
    this.warTrumpetAlert();
  }

  public playPopCappedAlert(): void {
    this.popCappedAlert();
  }
}

export const soundManager = new SoundManager();
