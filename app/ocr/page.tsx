"use client"

import { useState } from "react"
import Link from "next/link"
import { ArrowLeft, ScanText, Copy, Check, Languages, Download } from "lucide-react"
import { Button } from "@/components/ui/button"

const EXTRACTED_TEXT = `ACME CORPORATION
Business Correspondence

Dear Valued Customer,

Thank you for your recent inquiry regarding our enterprise document management services. We are pleased to confirm that your account has been successfully activated as of this month.

Your subscription includes unlimited cloud storage, automatic OCR text extraction, and priority support access. Should you require any assistance, our team is available Monday through Friday, 9:00 AM to 6:00 PM.

We look forward to a productive partnership.

Sincerely,
The ACME Team`

export default function Page() {
  const [text, setText] = useState(EXTRACTED_TEXT)
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  const handleExport = () => {
    const blob = new Blob([text], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "extracted-text.txt"
    a.click()
    URL.revokeObjectURL(url)
  }

  const charCount = text.length
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0

  return (
    <main className="mx-auto flex h-dvh w-full max-w-md flex-col overflow-hidden bg-background text-foreground">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-foreground hover:bg-secondary"
          aria-label="Go back"
          nativeButton={false}
          render={
            <Link href="/">
              <ArrowLeft className="size-5" />
            </Link>
          }
        />
        <div className="flex items-center gap-2">
          <ScanText className="size-4 text-primary" />
          <h1 className="text-base font-semibold">Extracted Text</h1>
        </div>
        <div className="size-9" aria-hidden />
      </header>

      {/* Top half: scanned document image */}
      <section className="relative flex h-[38%] shrink-0 items-center justify-center overflow-hidden bg-secondary/40">
        <img
          src="/document-scan.png"
          alt="Scanned document being processed for text extraction"
          className="h-full w-full object-contain p-3"
        />
        <span className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-background/80 px-3 py-1 text-xs font-medium text-foreground backdrop-blur">
          <span className="size-1.5 rounded-full bg-primary" />
          Source scan
        </span>
      </section>

      {/* Bottom half: editable extracted text */}
      <section className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-y border-border bg-card/40 px-4 py-2">
          <span className="text-xs font-medium text-muted-foreground">Editable text</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {wordCount} words · {charCount} chars
          </span>
        </div>
        <label htmlFor="ocr-text" className="sr-only">
          Extracted document text
        </label>
        <textarea
          id="ocr-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          className="flex-1 resize-none bg-background px-4 py-4 font-mono text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-0"
          placeholder="Extracted text will appear here..."
        />
      </section>

      {/* Sticky bottom toolbar */}
      <footer className="sticky bottom-0 grid grid-cols-3 gap-2 border-t border-border bg-card/80 p-3 backdrop-blur">
        <Button
          variant="secondary"
          className="h-12 flex-col gap-1 rounded-xl text-xs font-medium"
          onClick={handleCopy}
        >
          {copied ? (
            <Check className="size-5 text-primary" />
          ) : (
            <Copy className="size-5" />
          )}
          {copied ? "Copied" : "Copy Text"}
        </Button>
        <Button
          variant="secondary"
          className="h-12 flex-col gap-1 rounded-xl text-xs font-medium"
        >
          <Languages className="size-5" />
          Translate
        </Button>
        <Button
          className="h-12 flex-col gap-1 rounded-xl text-xs font-medium"
          onClick={handleExport}
        >
          <Download className="size-5" />
          Export .TXT
        </Button>
      </footer>
    </main>
  )
}
