'use client';

import { useEffect, useRef } from 'react';

const STAR_COUNT = 150;
const COMET_INTERVAL_MIN = 6000;  // ms between comets
const COMET_INTERVAL_MAX = 15000;

interface Star {
  x: number;
  y: number;
  size: number;
  baseOpacity: number;
  twinkleSpeed: number;
  twinkleOffset: number;
}

interface Comet {
  x: number;
  y: number;
  angle: number;
  speed: number;
  length: number;
  opacity: number;
  life: number;
  maxLife: number;
}

export default function ParticleBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const c = canvas; // non-null alias for closures
    let animationId: number;
    let stars: Star[] = [];
    let comets: Comet[] = [];
    let lastCometTime = 0;
    let nextCometDelay = randomBetween(COMET_INTERVAL_MIN, COMET_INTERVAL_MAX);

    function randomBetween(min: number, max: number) {
      return min + Math.random() * (max - min);
    }

    function resize() {
      c.width = window.innerWidth;
      c.height = window.innerHeight;
      initStars();
    }

    function initStars() {
      stars = [];
      for (let i = 0; i < STAR_COUNT; i++) {
        stars.push({
          x: Math.random() * c.width,
          y: Math.random() * c.height,
          size: Math.random() * 1.8 + 0.3,
          baseOpacity: Math.random() * 0.5 + 0.15,
          twinkleSpeed: Math.random() * 0.008 + 0.002,
          twinkleOffset: Math.random() * Math.PI * 2,
        });
      }
    }

    function spawnComet() {
      // Start from a random edge, angled across the screen
      const startEdge = Math.random();
      let x: number, y: number, angle: number;

      if (startEdge < 0.5) {
        // From top
        x = Math.random() * c.width;
        y = -20;
        angle = randomBetween(0.3, 0.8) * Math.PI; // downward angles
      } else {
        // From right
        x = c.width + 20;
        y = Math.random() * c.height * 0.5;
        angle = randomBetween(0.6, 0.9) * Math.PI; // leftward-downward
      }

      comets.push({
        x,
        y,
        angle,
        speed: randomBetween(4, 8),
        length: randomBetween(400, 900),
        opacity: randomBetween(0.3, 0.6),
        life: 0,
        maxLife: randomBetween(120, 200),
      });
    }

    function drawStar(star: Star, time: number) {
      const twinkle = Math.sin(time * star.twinkleSpeed + star.twinkleOffset);
      const opacity = star.baseOpacity + twinkle * 0.25;
      if (opacity <= 0) return;

      ctx!.beginPath();
      ctx!.arc(star.x, star.y, star.size, 0, Math.PI * 2);
      ctx!.fillStyle = `rgba(200, 220, 255, ${Math.max(0, opacity)})`;
      ctx!.fill();

      // Subtle glow on brighter stars
      if (star.size > 1.2 && opacity > 0.4) {
        ctx!.beginPath();
        ctx!.arc(star.x, star.y, star.size * 2.5, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(0, 240, 255, ${opacity * 0.08})`;
        ctx!.fill();
      }
    }

    function drawComet(comet: Comet) {
      const dx = Math.cos(comet.angle) * comet.speed;
      const dy = Math.sin(comet.angle) * comet.speed;

      // Fade in and out
      const lifePct = comet.life / comet.maxLife;
      let fadeOpacity = comet.opacity;
      if (lifePct < 0.1) fadeOpacity *= lifePct / 0.1;
      if (lifePct > 0.7) fadeOpacity *= (1 - lifePct) / 0.3;

      // Tail gradient
      const tailX = comet.x - Math.cos(comet.angle) * comet.length;
      const tailY = comet.y - Math.sin(comet.angle) * comet.length;

      const gradient = ctx!.createLinearGradient(tailX, tailY, comet.x, comet.y);
      gradient.addColorStop(0, `rgba(0, 240, 255, 0)`);
      gradient.addColorStop(0.7, `rgba(0, 240, 255, ${fadeOpacity * 0.3})`);
      gradient.addColorStop(1, `rgba(255, 255, 255, ${fadeOpacity})`);

      ctx!.beginPath();
      ctx!.moveTo(tailX, tailY);
      ctx!.lineTo(comet.x, comet.y);
      ctx!.strokeStyle = gradient;
      ctx!.lineWidth = 1.5;
      ctx!.stroke();

      // Bright head
      ctx!.beginPath();
      ctx!.arc(comet.x, comet.y, 1.5, 0, Math.PI * 2);
      ctx!.fillStyle = `rgba(255, 255, 255, ${fadeOpacity})`;
      ctx!.fill();

      // Update position
      comet.x += dx;
      comet.y += dy;
      comet.life++;
    }

    function animate(time: number) {
      ctx!.clearRect(0, 0, c.width, c.height);

      // Draw stars
      for (const star of stars) {
        drawStar(star, time);
      }

      // Spawn comets
      if (time - lastCometTime > nextCometDelay) {
        spawnComet();
        lastCometTime = time;
        nextCometDelay = randomBetween(COMET_INTERVAL_MIN, COMET_INTERVAL_MAX);
      }

      // Draw and filter comets
      comets = comets.filter((c) => c.life < c.maxLife);
      for (const comet of comets) {
        drawComet(comet);
      }

      animationId = requestAnimationFrame(animate);
    }

    resize();
    window.addEventListener('resize', resize);
    animationId = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-0 pointer-events-none"
      style={{ opacity: 0.7 }}
    />
  );
}
