'use client';

import { useEffect, useState } from 'react';

export default function ParticleBackground() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Dynamic import to avoid SSR issues
    const loadParticles = async () => {
      try {
        const { tsParticles } = await import('@tsparticles/slim' as any);
        // @ts-ignore
        await tsParticles.load({
          id: 'tsparticles',
          options: {
            background: { color: { value: 'transparent' } },
            fpsLimit: 30,
            particles: {
              color: { value: ['#00F0FF', '#A855F7', '#1E3A5F'] },
              links: {
                color: '#1E3A5F',
                distance: 150,
                enable: true,
                opacity: 0.15,
                width: 1,
              },
              move: {
                enable: true,
                speed: 0.3,
                direction: 'none' as any,
                outModes: { default: 'bounce' as any },
              },
              number: {
                density: { enable: true, width: 1920, height: 1080 },
                value: 60,
              },
              opacity: {
                value: { min: 0.1, max: 0.4 },
                animation: {
                  enable: true,
                  speed: 0.5,
                  sync: false,
                },
              },
              shape: { type: 'circle' },
              size: {
                value: { min: 1, max: 3 },
              },
            },
            detectRetina: true,
          },
        });
      } catch {
        // Gracefully degrade — no particles
      }
    };

    loadParticles();
  }, []);

  if (!mounted) return null;

  return <div id="tsparticles" />;
}
