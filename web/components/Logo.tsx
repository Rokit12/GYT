import { useId } from "react";

/**
 * GYT mark: a yacht on moving water inside a brass compass ring (tracking), with a block node at
 * north (verified on-chain). Waves drift; the ring turns a quarter on hover (see .brand2 in CSS).
 */
export function LogoMark({ size = 44 }: { size?: number }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className="gyt-mark" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`sea${id}`} x1="0" y1="0" x2=".55" y2="1">
          <stop offset="0" stopColor="#17A3A6" /><stop offset=".55" stopColor="#0C6A74" /><stop offset="1" stopColor="#08364A" />
        </linearGradient>
        <clipPath id={`clip${id}`}><circle cx="24" cy="24" r="18.6" /></clipPath>
      </defs>
      <circle cx="24" cy="24" r="18.6" fill={`url(#sea${id})`} />
      <g clipPath={`url(#clip${id})`}>
        <path d="M16.6 22.3l1.5-3.2h8.2l2.9 3.2z" fill="#fff" />
        <path d="M20.6 19.1l.6-2.6h3l.9 2.6z" fill="#fff" opacity=".9" />
        <path d="M11.8 26.1l2-3.8h15.9l4.6 3.8z" fill="#fff" />
        <path d="M15.2 24.2h14.5" stroke="#08364A" strokeWidth="1.1" strokeLinecap="round" />
        <path d="M5.5 26.1h36.2l-4.6 4.6c-8.6 1.2-19.4 1-27.6-.6z" fill="#fff" />
        <path d="M10 28.3h25.8" stroke="#D6AC52" strokeWidth="1" strokeLinecap="round" />
        <g className="gyt-waves" fill="none" stroke="#fff" strokeLinecap="round">
          <path d="M-24 34.4q3-1.8 6 0t6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0" strokeWidth="1.5" opacity=".8" />
          <path d="M-21 38.4q3-1.8 6 0t6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0" strokeWidth="1.3" opacity=".42" />
        </g>
      </g>
      <circle className="gyt-ring" cx="24" cy="24" r="21.8" fill="none" stroke="#D6AC52" strokeWidth="1.7" strokeDasharray="29.24 5" strokeDashoffset="31.74" strokeLinecap="round" />
      <rect className="gyt-node" x="21.7" y=".55" width="4.6" height="4.6" rx=".9" transform="rotate(45 24 2.85)" fill="#D6AC52" />
    </svg>
  );
}

export function LogoLockup() {
  return (
    <>
      <span className="mark"><LogoMark /></span>
      <span className="wm"><b>GYT</b><small>Global Yacht<br />Tokenization</small></span>
    </>
  );
}
