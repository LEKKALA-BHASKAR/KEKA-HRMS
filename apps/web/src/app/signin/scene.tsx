/**
 * A sunset over the sea, drawn entirely in SVG: graded sky, noise-shaped
 * clouds lit from below, the sun on the horizon with its reflection, a
 * shimmering sea, foam, and a rippled beach. No images, no network.
 * Rendered once per auth page; ids are prefixed to stay unique.
 */
export function SunsetScene({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        {/* Sky */}
        <linearGradient id="ss-sky" x1="0" y1="0" x2="0" y2="600" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#102a63" />
          <stop offset=".22" stopColor="#1c4fa6" />
          <stop offset=".48" stopColor="#3f82d2" />
          <stop offset=".68" stopColor="#8dbbe6" />
          <stop offset=".8" stopColor="#d9dde0" />
          <stop offset=".88" stopColor="#f6c79a" />
          <stop offset=".95" stopColor="#f59358" />
          <stop offset="1" stopColor="#ee6a3a" />
        </linearGradient>
        <radialGradient id="ss-sunglow" cx="640" cy="598" r="330" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fffbe8" stopOpacity="1" />
          <stop offset=".08" stopColor="#ffe9a8" stopOpacity=".95" />
          <stop offset=".3" stopColor="#ffb46a" stopOpacity=".45" />
          <stop offset=".65" stopColor="#ff8a52" stopOpacity=".12" />
          <stop offset="1" stopColor="#ff8a52" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="ss-horizonglow" cx="640" cy="600" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(640 600) scale(560 60) translate(-640 -600)">
          <stop offset="0" stopColor="#ffd38a" stopOpacity=".9" />
          <stop offset=".5" stopColor="#ff9a5c" stopOpacity=".35" />
          <stop offset="1" stopColor="#ff9a5c" stopOpacity="0" />
        </radialGradient>

        {/* Clouds: fractal noise stretched sideways, used as a mask over a lit gradient. */}
        <filter id="ss-cloudnoise" x="0" y="0" width="1000" height="600" filterUnits="userSpaceOnUse">
          <feTurbulence type="fractalNoise" baseFrequency="0.0032 0.0105" numOctaves="5" seed="23" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  4.4 0 0 0 -1.86" />
        </filter>
        <filter id="ss-wispnoise" x="0" y="0" width="1000" height="600" filterUnits="userSpaceOnUse">
          <feTurbulence type="fractalNoise" baseFrequency="0.0016 0.03" numOctaves="4" seed="5" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  4.2 0 0 0 -2.05" />
        </filter>
        <filter id="ss-massnoise" x="0" y="0" width="1000" height="600" filterUnits="userSpaceOnUse">
          <feTurbulence type="fractalNoise" baseFrequency="0.0042 0.0085" numOctaves="5" seed="41" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  5.2 0 0 0 -2.2" />
        </filter>
        <radialGradient id="ss-massarea" cx="150" cy="150" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(150 150) scale(560 330) translate(-150 -150)">
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset=".6" stopColor="#fff" stopOpacity=".8" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="ss-massarea2" cx="900" cy="330" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(900 330) scale(330 150) translate(-900 -330)">
          <stop offset="0" stopColor="#fff" stopOpacity=".95" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id="ss-massmask" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="600">
          <rect width="1000" height="600" filter="url(#ss-massnoise)" />
        </mask>
        <mask id="ss-massregion" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="600">
          <rect width="1000" height="600" fill="url(#ss-massarea)" />
          <rect width="1000" height="600" fill="url(#ss-massarea2)" />
        </mask>
        <linearGradient id="ss-masscolour" x1="0" y1="0" x2="0" y2="520" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#141d4a" />
          <stop offset=".45" stopColor="#25306a" />
          <stop offset=".7" stopColor="#7a5d95" />
          <stop offset=".9" stopColor="#f09a8e" />
        </linearGradient>
        <linearGradient id="ss-cloudfade" x1="0" y1="0" x2="0" y2="600" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset=".55" stopColor="#fff" stopOpacity=".85" />
          <stop offset=".86" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="ss-cloudsideways" x1="0" y1="0" x2="1000" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset=".45" stopColor="#fff" stopOpacity=".55" />
          <stop offset=".7" stopColor="#fff" stopOpacity=".35" />
          <stop offset="1" stopColor="#fff" stopOpacity=".9" />
        </linearGradient>
        <mask id="ss-cloudmask" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="600">
          <rect width="1000" height="600" filter="url(#ss-cloudnoise)" />
        </mask>
        <mask id="ss-wispmask" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="600">
          <rect width="1000" height="600" filter="url(#ss-wispnoise)" />
        </mask>
        <mask id="ss-cloudarea" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="600">
          <rect width="1000" height="600" fill="url(#ss-cloudfade)" />
        </mask>
        <mask id="ss-cloudside" maskUnits="userSpaceOnUse" x="0" y="0" width="1000" height="600">
          <rect width="1000" height="600" fill="url(#ss-cloudsideways)" />
        </mask>
        <linearGradient id="ss-cloudcolour" x1="0" y1="0" x2="0" y2="600" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#18245a" />
          <stop offset=".28" stopColor="#2a3876" />
          <stop offset=".5" stopColor="#5f5794" />
          <stop offset=".66" stopColor="#c27d9c" />
          <stop offset=".8" stopColor="#ffab88" />
        </linearGradient>
        <radialGradient id="ss-cloudrim" cx="640" cy="600" r="520" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffd9a0" stopOpacity=".9" />
          <stop offset=".6" stopColor="#ff9f7a" stopOpacity=".25" />
          <stop offset="1" stopColor="#ff9f7a" stopOpacity="0" />
        </radialGradient>

        {/* Sea */}
        <linearGradient id="ss-sea" x1="0" y1="600" x2="0" y2="1000" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#a49cae" />
          <stop offset=".05" stopColor="#6f7fa6" />
          <stop offset=".25" stopColor="#3f5e8e" />
          <stop offset=".6" stopColor="#2c4a78" />
          <stop offset="1" stopColor="#223d66" />
        </linearGradient>
        <linearGradient id="ss-reflect" x1="0" y1="600" x2="0" y2="880" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff2c2" stopOpacity="1" />
          <stop offset=".25" stopColor="#ffc979" stopOpacity=".85" />
          <stop offset=".7" stopColor="#ff9358" stopOpacity=".35" />
          <stop offset="1" stopColor="#ff9358" stopOpacity="0" />
        </linearGradient>
        <filter id="ss-shimmer" x="0" y="600" width="1000" height="400" filterUnits="userSpaceOnUse">
          <feTurbulence type="fractalNoise" baseFrequency="0.004 0.16" numOctaves="3" seed="9" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  5 0 0 0 -2.6" />
        </filter>
        <mask id="ss-shimmermask" maskUnits="userSpaceOnUse" x="0" y="600" width="1000" height="400">
          <rect y="600" width="1000" height="400" filter="url(#ss-shimmer)" />
        </mask>
        <filter id="ss-glints" x="0" y="600" width="1000" height="400" filterUnits="userSpaceOnUse">
          <feTurbulence type="fractalNoise" baseFrequency="0.02 0.22" numOctaves="2" seed="17" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  3.4 0 0 0 -1.3" />
        </filter>
        <mask id="ss-glintmask" maskUnits="userSpaceOnUse" x="0" y="600" width="1000" height="400">
          <rect y="600" width="1000" height="400" filter="url(#ss-glints)" />
        </mask>
        <mask id="ss-reflectedge" maskUnits="userSpaceOnUse" x="0" y="600" width="1000" height="400">
          <path d="M626 598 L654 598 L724 900 L556 900 Z" fill="#fff" filter="url(#ss-wideblur)" />
        </mask>
        <radialGradient id="ss-reflectwide" cx="640" cy="640" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(640 640) scale(260 150) translate(-640 -640)">
          <stop offset="0" stopColor="#ffd28c" stopOpacity=".55" />
          <stop offset="1" stopColor="#ffd28c" stopOpacity="0" />
        </radialGradient>

        {/* Sand */}
        <linearGradient id="ss-sand" x1="1000" y1="700" x2="200" y2="1000" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f3d6a6" />
          <stop offset=".35" stopColor="#e5bb83" />
          <stop offset=".75" stopColor="#cf9a5f" />
          <stop offset="1" stopColor="#b47e48" />
        </linearGradient>
        <linearGradient id="ss-wet" x1="0" y1="760" x2="0" y2="900" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9aa6c0" stopOpacity=".55" />
          <stop offset=".6" stopColor="#c9a988" stopOpacity=".6" />
          <stop offset="1" stopColor="#d6b083" stopOpacity=".2" />
        </linearGradient>
        <filter id="ss-grain" x="0" y="680" width="1000" height="320" filterUnits="userSpaceOnUse">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="3" result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 .35  0 0 0 0 .24  0 0 0 0 .12  0 0 0 -1.1 .62" />
        </filter>
        <clipPath id="ss-sandclip">
          <path d="M0 902 C 160 878 300 846 450 812 C 610 776 780 742 1000 706 L1000 1000 L0 1000 Z" />
        </clipPath>

        <radialGradient id="ss-vignette" cx="500" cy="520" r="760" gradientUnits="userSpaceOnUse">
          <stop offset=".55" stopColor="#0a1428" stopOpacity="0" />
          <stop offset="1" stopColor="#0a1428" stopOpacity=".42" />
        </radialGradient>
        <filter id="ss-soft" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
        <filter id="ss-wideblur" x="-100%" y="-20%" width="300%" height="140%">
          <feGaussianBlur stdDeviation="16 10" />
        </filter>
        <filter id="ss-sunblur" x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      {/* Sky and light */}
      <rect width="1000" height="600" fill="url(#ss-sky)" />
      <rect width="1000" height="600" fill="url(#ss-sunglow)" />

      {/* Clouds, lit warm near the sun and cool overhead */}
      <g mask="url(#ss-cloudarea)">
        <g mask="url(#ss-cloudside)">
          <rect width="1000" height="600" fill="url(#ss-cloudcolour)" mask="url(#ss-cloudmask)" opacity=".92" />
          <rect width="1000" height="600" fill="url(#ss-cloudrim)" mask="url(#ss-cloudmask)" opacity=".55" />
        </g>
        <rect y="300" width="1000" height="300" fill="#f4a07f" mask="url(#ss-wispmask)" opacity=".5" />
        <g mask="url(#ss-massregion)">
          <rect width="1000" height="600" fill="url(#ss-masscolour)" mask="url(#ss-massmask)" opacity=".9" />
          <rect width="1000" height="600" fill="url(#ss-cloudrim)" mask="url(#ss-massmask)" opacity=".35" />
        </g>
      </g>
      <rect y="520" width="1000" height="90" fill="url(#ss-horizonglow)" />

      {/* Birds */}
      <g fill="none" stroke="#1a2547" strokeWidth="1.6" strokeLinecap="round" opacity=".55">
        <path d="M372 318 q6 -6 12 0 q6 -6 12 0" />
        <path d="M404 300 q4 -4 8 0 q4 -4 8 0" />
        <path d="M352 336 q3.5 -3.5 7 0 q3.5 -3.5 7 0" />
      </g>

      {/* The sun, sitting on the horizon */}
      <circle cx="640" cy="596" r="34" fill="#fff1c4" filter="url(#ss-sunblur)" opacity=".9" />
      <circle cx="640" cy="598" r="17" fill="#fffdf2" />

      {/* A distant sail */}
      <g opacity=".6">
        <path d="M262 598 l9 -22 l1 22 z" fill="#2a3456" />
        <path d="M256 598 h22 l-3 3 h-16 z" fill="#2a3456" />
      </g>

      {/* Sea */}
      <rect y="600" width="1000" height="400" fill="url(#ss-sea)" />
      <rect y="600" width="1000" height="400" fill="#dfe8f5" mask="url(#ss-shimmermask)" opacity=".28" />
      <ellipse cx="640" cy="640" rx="260" ry="150" fill="url(#ss-reflectwide)" />
      <path d="M630 600 L650 600 L680 780 L600 780 Z" fill="url(#ss-reflect)" opacity=".55" filter="url(#ss-wideblur)" />
      <g mask="url(#ss-reflectedge)">
        <g mask="url(#ss-glintmask)">
          <path d="M610 600 L670 600 L770 900 L510 900 Z" fill="url(#ss-reflect)" />
        </g>
      </g>
      <rect y="599" width="1000" height="2.2" fill="#ffe2b0" opacity=".55" />

      {/* Swell lines */}
      <g fill="none" stroke="#c9d6ea" strokeLinecap="round" opacity=".22">
        <path d="M0 700 C 140 694 260 706 420 698 S 760 690 1000 696" strokeWidth="1.2" />
        <path d="M0 746 C 160 738 300 752 480 742 S 800 732 1000 738" strokeWidth="1.4" />
        <path d="M0 800 C 120 792 280 806 430 796 S 700 784 860 782" strokeWidth="1.6" />
      </g>

      {/* Wet sand and foam along the shoreline */}
      <path d="M0 876 C 170 856 310 824 460 794 C 620 762 790 730 1000 694 L1000 716 C 780 752 610 786 452 820 C 300 854 160 884 0 910 Z" fill="url(#ss-wet)" />
      <g fill="none" stroke="#ffffff" strokeLinecap="round">
        <path d="M0 874 C 120 860 210 848 300 832 C 380 818 430 802 520 786 C 640 762 800 734 1000 694" strokeWidth="9" opacity=".28" filter="url(#ss-sunblur)" />
        <path d="M0 872 C 120 858 210 846 300 830 C 380 816 430 800 520 784 C 640 760 800 732 1000 692" strokeWidth="3" opacity=".75" filter="url(#ss-soft)" />
        <path d="M0 866 C 90 854 170 846 250 832 C 330 818 360 806 420 798" strokeWidth="1.6" opacity=".9" />
        <path d="M540 776 C 640 758 760 738 900 712" strokeWidth="1.4" opacity=".8" />
        <path d="M0 846 C 110 834 230 812 360 792 C 460 776 520 768 600 752" strokeWidth="1.2" opacity=".35" />
      </g>

      {/* Beach */}
      <g clipPath="url(#ss-sandclip)">
        <rect y="680" width="1000" height="320" fill="url(#ss-sand)" />
        <rect y="680" width="1000" height="320" filter="url(#ss-grain)" opacity=".5" />
        <g fill="none" strokeLinecap="round">
          <g stroke="#a8743f" strokeOpacity=".22" strokeWidth="2">
            <path d="M120 960 C 220 930 330 920 430 892 S 640 846 760 834" />
            <path d="M40 1000 C 180 968 300 962 420 936 S 640 892 820 872" />
            <path d="M300 1000 C 420 976 540 962 660 930 S 860 892 1000 870" />
            <path d="M560 1000 C 660 984 780 966 880 942 S 960 930 1000 924" />
            <path d="M480 880 C 580 860 680 846 800 822 S 940 800 1000 790" />
            <path d="M640 840 C 740 820 840 804 1000 772" />
          </g>
          <g stroke="#fde6c2" strokeOpacity=".32" strokeWidth="1.4">
            <path d="M120 956 C 220 926 330 916 430 888 S 640 842 760 830" />
            <path d="M40 996 C 180 964 300 958 420 932 S 640 888 820 868" />
            <path d="M300 996 C 420 972 540 958 660 926 S 860 888 1000 866" />
            <path d="M480 876 C 580 856 680 842 800 818 S 940 796 1000 786" />
          </g>
        </g>
        {/* A few shells and pebbles */}
        <g>
          <ellipse cx="712" cy="902" rx="5" ry="3" fill="#fff5e6" opacity=".8" />
          <ellipse cx="820" cy="948" rx="3.5" ry="2.2" fill="#7c5a3a" opacity=".55" />
          <ellipse cx="560" cy="968" rx="4" ry="2.5" fill="#fff1dc" opacity=".7" />
          <ellipse cx="900" cy="860" rx="3" ry="2" fill="#7c5a3a" opacity=".5" />
        </g>
      </g>

      <rect width="1000" height="1000" fill="url(#ss-vignette)" />
    </svg>
  );
}
