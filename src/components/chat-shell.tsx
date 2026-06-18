"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUp,
  BookOpen,
  ExternalLink,
  FileText,
  Globe2,
  Menu,
  MessageSquarePlus,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { Markdown } from "@/components/markdown";
import type { ChatMessage, Source } from "@/lib/types";

const welcomeMessage: ChatMessage = {
  role: "assistant",
  content:
    "Hi, I’m **Atlas**. Ask me anything about the information in this knowledge base. I’ll answer from the available sources and show you where each answer came from.",
};

const suggestions = [
  "Give me a quick overview of the knowledge base.",
  "What are the most important policies I should know?",
  "Summarize the key points across the available resources.",
];

function SourceIcon({ type }: { type: Source["type"] }) {
  if (type === "url") return <Globe2 size={15} />;
  return <FileText size={15} />;
}

function SourceList({ sources }: { sources: Source[] }) {
  if (!sources.length) return null;

  return (
    <div className="source-list">
      <p className="source-heading">
        <BookOpen size={14} /> Sources
      </p>
      <div className="source-grid">
        {sources.map((source, index) => {
          const content = (
            <>
              <span className="source-number">{index + 1}</span>
              <span className="source-copy">
                <strong>
                  <SourceIcon type={source.type} />
                  {source.name}
                </strong>
                <span>{source.excerpt}</span>
              </span>
              {source.url && <ExternalLink size={14} />}
            </>
          );

          return source.url ? (
            <a
              className="source-card"
              href={source.url}
              target="_blank"
              rel="noreferrer"
              key={source.id}
            >
              {content}
            </a>
          ) : (
            <div className="source-card" key={source.id}>
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ChatShell() {
  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function resetConversation() {
    setMessages([welcomeMessage]);
    setInput("");
    setSidebarOpen(false);
    inputRef.current?.focus();
  }

  async function askQuestion(question: string) {
    const trimmed = question.trim();
    if (!trimmed || loading) return;

    const nextMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: trimmed },
    ];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages
            .filter((message) => message !== welcomeMessage)
            .map(({ role, content }) => ({ role, content })),
        }),
      });
      const data = (await response.json()) as {
        answer?: string;
        sources?: Source[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "Request failed.");

      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: data.answer || "I could not produce an answer.",
          sources: data.sources || [],
        },
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content:
            error instanceof Error
              ? error.message
              : "Something went wrong. Please try again.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void askQuestion(input);
  }

  return (
    <div className="chat-app">
      <aside className={`chat-sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <div className="sidebar-top">
          <Logo />
          <button
            className="icon-button sidebar-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            <X size={19} />
          </button>
        </div>

        <button className="new-chat-button" onClick={resetConversation}>
          <MessageSquarePlus size={17} />
          New conversation
        </button>

        <div className="sidebar-section">
          <span className="eyebrow">Try asking</span>
          <div className="prompt-list">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => {
                  setSidebarOpen(false);
                  void askQuestion(suggestion);
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>

        <div className="sidebar-foot">
          <div className="grounded-note">
            <ShieldCheck size={17} />
            <span>
              <strong>Grounded answers</strong>
              Responses use your approved sources.
            </span>
          </div>
          <Link href="/admin" className="admin-link">
            Manage knowledge base
            <ExternalLink size={14} />
          </Link>
        </div>
      </aside>

      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close menu"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="chat-main">
        <header className="chat-header">
          <button
            className="icon-button mobile-menu"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
          <div>
            <span className="status-dot" />
            Knowledge assistant
          </div>
          <span className="model-label">
            <Sparkles size={14} />
            Open source
          </span>
        </header>

        <section className="conversation">
          <div className="message-stack">
            {messages.map((message, index) => (
              <article
                className={`message-row ${message.role}`}
                key={`${message.role}-${index}`}
              >
                {message.role === "assistant" && (
                  <span className="assistant-avatar" aria-hidden="true">
                    <Sparkles size={17} />
                  </span>
                )}
                <div className="message-content">
                  {message.role === "assistant" ? (
                    <Markdown>{message.content}</Markdown>
                  ) : (
                    <p>{message.content}</p>
                  )}
                  {message.sources && <SourceList sources={message.sources} />}
                </div>
              </article>
            ))}

            {loading && (
              <article className="message-row assistant">
                <span className="assistant-avatar" aria-hidden="true">
                  <Sparkles size={17} />
                </span>
                <div className="thinking">
                  <span />
                  <span />
                  <span />
                  Searching the knowledge base
                </div>
              </article>
            )}
            <div ref={bottomRef} />
          </div>
        </section>

        <div className="composer-wrap">
          <form className="composer" onSubmit={handleSubmit}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void askQuestion(input);
                }
              }}
              placeholder="Ask a question about your knowledge base..."
              rows={1}
              maxLength={8000}
              aria-label="Your question"
            />
            <button
              className="send-button"
              disabled={!input.trim() || loading}
              aria-label="Send question"
            >
              <ArrowUp size={19} />
            </button>
          </form>
          <p className="composer-note">
            Atlas answers from indexed sources. Check citations for important
            decisions.
          </p>
        </div>
      </main>
    </div>
  );
}
