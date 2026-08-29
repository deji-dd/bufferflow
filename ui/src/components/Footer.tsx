import type React from 'react';

export const Footer: React.FC = () => {
  return (
    <footer className="glass-card rounded-2xl px-6 py-4 flex justify-between items-center flex-wrap gap-4 text-xs text-[#64748b]">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-white">Bufferflow</span>
        <span>•</span>
        <span>
          Designed &amp; Engineered by{' '}
          <a
            href="https://github.com/deji-dd"
            target="_blank"
            rel="noreferrer"
            className="text-[#00f0ff] hover:underline font-medium"
          >
            Ayodeji
          </a>
        </span>
      </div>

      <div className="flex items-center gap-4 text-[11px] font-mono">
        <a
          href="https://github.com/deji-dd/bufferflow"
          target="_blank"
          rel="noreferrer"
          className="hover:text-white transition"
        >
          GitHub
        </a>

        <span className="text-white/10">•</span>
        <span>&copy; {new Date().getFullYear()}</span>
      </div>
    </footer>
  );
};
