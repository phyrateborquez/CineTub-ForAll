// Reads metadata through the embedded player, without an API key.
class VideoDurationDetector {
  constructor(urlInput, minutesInput, secondsInput) {
    this.urlInput = urlInput;
    this.minutesInput = minutesInput;
    this.secondsInput = secondsInput;
    this.generation = 0;
    this.panel = document.createElement('div');
    this.panel.className = 'video-preview hidden';
    this.status = document.createElement('p');
    this.status.setAttribute('role', 'status');
    this.host = document.createElement('div');
    this.panel.append(this.status, this.host);
    urlInput.closest('form').append(this.panel);
    urlInput.addEventListener('input', () => {
      this.reset();
      minutesInput.value = '';
      secondsInput.value = '';
      this.debounce = setTimeout(() => this.detect(), 500);
    });
    minutesInput.addEventListener('input', () => this.reset());
    secondsInput.addEventListener('input', () => this.reset());
  }

  static videoId(value) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol)) return null;
      let id;
      if (url.hostname === 'youtu.be') {
        id = url.pathname.slice(1).split('/')[0];
      } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
        const parts = url.pathname.split('/');
        id = url.pathname === '/watch' ? url.searchParams.get('v')
          : ['shorts', 'embed', 'live'].includes(parts[1]) ? parts[2] : null;
      }
      return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? id : null;
    } catch {
      return null;
    }
  }

  static loadPlayer() {
    if (window.YT?.Player) return Promise.resolve();
    if (!this.loading) {
      this.loading = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 15000);
        window.onYouTubeIframeAPIReady = () => {
          clearTimeout(timeout);
          resolve();
        };
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.onerror = () => {
          clearTimeout(timeout);
          script.remove();
          reject(new Error('No se pudo cargar YouTube'));
        };
        document.head.append(script);
      }).catch(error => {
        this.loading = null;
        throw error;
      });
    }
    return this.loading;
  }

  reset() {
    this.generation += 1;
    clearTimeout(this.debounce);
    clearTimeout(this.timeout);
    clearInterval(this.poll);
    this.player?.destroy();
    this.player = null;
    this.host.replaceChildren();
    this.panel.classList.add('hidden');
  }

  async detect() {
    const id = VideoDurationDetector.videoId(this.urlInput.value.trim());
    if (!id) return;
    const generation = this.generation;
    this.panel.classList.remove('hidden');
    this.status.textContent = 'Obteniendo duración… Si hace falta, pulsa reproducir en la vista previa.';
    try {
      await VideoDurationDetector.loadPlayer();
      if (generation !== this.generation) return;
      const container = document.createElement('div');
      this.host.append(container);
      this.player = new YT.Player(container, {
        videoId: id,
        width: '100%',
        height: '240',
        playerVars: { origin: window.location.origin, playsinline: 1 },
        events: {
          onReady: () => {
            if (generation !== this.generation) return;
            this.poll = setInterval(() => {
              if (generation !== this.generation) return;
              const data = this.player.getVideoData();
              if (data.isLive) {
                this.fail('Este video es una emisión en vivo y no tiene una duración fija.');
                return;
              }
              const duration = this.player.getDuration();
              if (!Number.isFinite(duration) || duration <= 0) return;
              this.minutesInput.value = Math.floor(Math.round(duration) / 60);
              this.secondsInput.value = Math.round(duration) % 60;
              this.reset();
              this.panel.classList.remove('hidden');
              this.status.textContent = 'Duración completada automáticamente. Puedes ajustarla antes de guardar.';
            }, 300);
          },
          onError: () => {
            if (generation === this.generation) this.fail('No se pudo leer este video. Ingresa la duración manualmente.');
          },
        },
      });
      this.timeout = setTimeout(() => {
        if (generation === this.generation) this.fail('No se pudo obtener la duración. Ingresa los minutos y segundos manualmente.');
      }, 60000);
    } catch {
      if (generation === this.generation) this.fail('No se pudo conectar con YouTube. Ingresa la duración manualmente.');
    }
  }

  fail(message) {
    this.reset();
    this.panel.classList.remove('hidden');
    this.status.textContent = message;
  }
}

