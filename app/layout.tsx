import type { Metadata, Viewport } from "next";
import "katex/dist/katex.min.css";
import "./globals.css";

export const metadata: Metadata = {
  // Title is owned by the client-side <TabTitle /> (lib/attention.ts store) so
  // it can reflect session name + agent running state. Declaring it here too
  // would make React's metadata hoisting overwrite every dynamic update.
  description: "Pi Coding Agent Web Interface",
  // Installed-app behavior on iOS (Android reads the PWA manifest instead).
  appleWebApp: {
    capable: true,
    title: "pi web",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Soft keyboards shrink the layout viewport instead of overlaying it, so
  // the composer stays visible while typing on mobile.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("pi-theme");if(t==="dark"){document.documentElement.classList.add("dark")}else if(t===null&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches){document.documentElement.classList.add("dark")}var s=localStorage.getItem("pi-skin")||"editorial";if(s!=="terminal"&&["industrial","aurora","editorial","glass"].indexOf(s)>=0){document.documentElement.setAttribute("data-skin",s)}var f=localStorage.getItem("pi-font-size");if(f!=="default"&&["small","large","xlarge"].indexOf(f)>=0){document.documentElement.setAttribute("data-font-size",f)}var ff=localStorage.getItem("pi-font-family");if(ff!=="sans"&&["mono","system"].indexOf(ff)>=0){document.documentElement.setAttribute("data-font-family",ff)}var ml=localStorage.getItem("pi-message-layout");if(ml==="left"){document.documentElement.setAttribute("data-message-layout",ml)}}catch(e){}})();`,
          }}
        />
      </head>
      <body style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
        {children}
      </body>
    </html>
  );
}
