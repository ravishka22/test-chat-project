"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  File,
  FileText,
  Globe2,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Type,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { Logo } from "@/components/logo";
import type { Resource, ResourceType } from "@/lib/types";

type AddMode = "url" | "file" | "text";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function ResourceIcon({ type }: { type: ResourceType }) {
  if (type === "url") return <Globe2 size={19} />;
  if (type === "pdf") return <FileText size={19} />;
  if (type === "docx") return <File size={19} />;
  return <Type size={19} />;
}

export function AdminDashboard() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [mode, setMode] = useState<AddMode>("url");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [crawlSite, setCrawlSite] = useState(false);
  const [maxPages, setMaxPages] = useState(5);
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function loadResources() {
    setLoading(true);
    try {
      const response = await fetch("/api/resources", { cache: "no-store" });
      if (response.status === 401) {
        router.push("/admin/login");
        return;
      }
      const data = (await response.json()) as {
        resources?: Resource[];
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "Could not load resources.");
      setResources(data.resources || []);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not load resources.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadResources();
    // This only needs to run on initial mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredResources = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return resources;
    return resources.filter(
      (resource) =>
        resource.name.toLowerCase().includes(query) ||
        resource.sourceUrl?.toLowerCase().includes(query) ||
        resource.fileName?.toLowerCase().includes(query),
    );
  }, [resources, search]);

  const readyResources = resources.filter(
    (resource) => resource.status === "ready",
  );
  const totalChunks = readyResources.reduce(
    (total, resource) => total + resource.chunkCount,
    0,
  );

  function changeMode(nextMode: AddMode) {
    setMode(nextMode);
    setError("");
    setSuccess("");
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setSuccess("");

    const formData = new FormData();
    formData.set("mode", mode);
    formData.set("name", name);
    if (mode === "url") formData.set("url", url);
    if (mode === "url") formData.set("crawlSite", String(crawlSite));
    if (mode === "url") formData.set("maxPages", String(maxPages));
    if (mode === "text") formData.set("content", content);
    if (mode === "file" && file) formData.set("file", file);

    try {
      const response = await fetch("/api/resources", {
        method: "POST",
        body: formData,
      });
      const data = (await response.json()) as {
        resource?: Resource;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || "Could not add resource.");

      setSuccess(`${data.resource?.name || "Resource"} is ready to search.`);
      setName("");
      setUrl("");
      setCrawlSite(false);
      setMaxPages(5);
      setContent("");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadResources();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not add resource.",
      );
      await loadResources();
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteResource(resource: Resource) {
    if (!window.confirm(`Remove "${resource.name}" from the knowledge base?`)) {
      return;
    }

    setDeletingId(resource.id);
    setError("");
    try {
      const response = await fetch(`/api/resources/${resource.id}`, {
        method: "DELETE",
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error || "Delete failed.");
      setResources((current) =>
        current.filter((item) => item.id !== resource.id),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Delete failed.");
    } finally {
      setDeletingId(null);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/admin/login");
    router.refresh();
  }

  return (
    <div className="admin-app">
      <aside className="admin-sidebar">
        <Logo />
        <nav>
          <a className="active" href="#overview">
            <LayoutDashboard size={18} /> Overview
          </a>
          <a href="#resources">
            <BookOpen size={18} /> Resources
          </a>
          <a href="#add-resource">
            <Plus size={18} /> Add resource
          </a>
        </nav>
        <div className="admin-sidebar-foot">
          <Link href="/">
            <ArrowLeft size={17} /> Open assistant
          </Link>
          <button onClick={logout}>
            <LogOut size={17} /> Sign out
          </button>
        </div>
      </aside>

      <main className="admin-main">
        <header className="admin-header" id="overview">
          <div>
            <p className="eyebrow">Knowledge management</p>
            <h1>Good to see you.</h1>
            <p>Curate the sources your assistant uses to answer questions.</p>
          </div>
          <Link className="secondary-button" href="/">
            Test assistant
            <ArrowLeft className="rotate-135" size={16} />
          </Link>
        </header>

        <section className="stat-grid" aria-label="Knowledge base summary">
          <article className="stat-card">
            <span className="stat-icon plum">
              <BookOpen size={20} />
            </span>
            <div>
              <strong>{resources.length}</strong>
              <span>Total resources</span>
            </div>
          </article>
          <article className="stat-card">
            <span className="stat-icon green">
              <CheckCircle2 size={20} />
            </span>
            <div>
              <strong>{readyResources.length}</strong>
              <span>Ready to search</span>
            </div>
          </article>
          <article className="stat-card">
            <span className="stat-icon gold">
              <FileText size={20} />
            </span>
            <div>
              <strong>{totalChunks}</strong>
              <span>Indexed passages</span>
            </div>
          </article>
        </section>

        <section className="admin-panel add-resource-panel" id="add-resource">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Grow the knowledge base</p>
              <h2>Add a resource</h2>
            </div>
          </div>

          <div className="resource-tabs" role="tablist">
            <button
              className={mode === "url" ? "active" : ""}
              onClick={() => changeMode("url")}
              type="button"
            >
              <Link2 size={17} /> Web page
            </button>
            <button
              className={mode === "file" ? "active" : ""}
              onClick={() => changeMode("file")}
              type="button"
            >
              <UploadCloud size={17} /> Upload file
            </button>
            <button
              className={mode === "text" ? "active" : ""}
              onClick={() => changeMode("text")}
              type="button"
            >
              <Type size={17} /> Manual text
            </button>
          </div>

          <form className="resource-form" onSubmit={handleAdd}>
            <div className="field">
              <label htmlFor="resource-name">
                Display name {mode !== "text" && <span>Optional</span>}
              </label>
              <input
                id="resource-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={
                  mode === "text"
                    ? "e.g. Refund policy"
                    : "A clear name for this source"
                }
                required={mode === "text"}
              />
            </div>

            {mode === "url" && (
              <div className="field">
                <label htmlFor="resource-url">Public URL</label>
                <div className="input-with-icon">
                  <Globe2 size={18} />
                  <input
                    id="resource-url"
                    type="url"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://example.com/help/article"
                    required
                  />
                </div>
                <small>
                  Atlas can index one page or crawl linked pages on the same
                  site.
                </small>
                <div className="crawl-options">
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={crawlSite}
                      onChange={(event) => setCrawlSite(event.target.checked)}
                    />
                    <span>Crawl linked pages on this site</span>
                  </label>
                  {crawlSite && (
                    <label className="mini-field">
                      Max pages
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={maxPages}
                        onChange={(event) =>
                          setMaxPages(Number(event.target.value))
                        }
                      />
                    </label>
                  )}
                </div>
              </div>
            )}

            {mode === "file" && (
              <div className="field">
                <label htmlFor="resource-file">Document</label>
                <label className={`file-drop ${file ? "has-file" : ""}`}>
                  <input
                    ref={fileInputRef}
                    id="resource-file"
                    type="file"
                    accept=".pdf,.docx,.txt,.md,text/plain,application/pdf"
                    onChange={(event) =>
                      setFile(event.target.files?.[0] || null)
                    }
                    required
                  />
                  <span className="upload-icon">
                    {file ? <CheckCircle2 size={25} /> : <UploadCloud size={25} />}
                  </span>
                  <strong>{file ? file.name : "Choose a document"}</strong>
                  <span>
                    {file
                      ? `${(file.size / 1024 / 1024).toFixed(2)} MB`
                      : "PDF, DOCX, TXT, or Markdown up to 10 MB"}
                  </span>
                </label>
              </div>
            )}

            {mode === "text" && (
              <div className="field">
                <label htmlFor="resource-content">Knowledge text</label>
                <textarea
                  id="resource-content"
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="Paste a policy, FAQ, product note, or any other information..."
                  rows={7}
                  required
                />
              </div>
            )}

            {error && (
              <p className="form-alert error">
                <XCircle size={17} /> {error}
              </p>
            )}
            {success && (
              <p className="form-alert success">
                <CheckCircle2 size={17} /> {success}
              </p>
            )}

            <div className="form-actions">
              <button
                className="primary-button"
                disabled={
                  submitting ||
                  (mode === "url" && !url) ||
                  (mode === "file" && !file) ||
                  (mode === "text" && (!name || !content))
                }
              >
                {submitting ? (
                  <>
                    <LoaderCircle className="spin" size={17} />
                    Extracting and indexing...
                  </>
                ) : (
                  <>
                    <Plus size={17} />
                    Add to knowledge base
                  </>
                )}
              </button>
              <span>Embedding may take a moment for larger documents.</span>
            </div>
          </form>
        </section>

        <section className="admin-panel" id="resources">
          <div className="panel-heading resource-heading">
            <div>
              <p className="eyebrow">Indexed content</p>
              <h2>Your resources</h2>
            </div>
            <div className="resource-tools">
              <label className="search-field">
                <Search size={16} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search resources"
                  aria-label="Search resources"
                />
              </label>
              <button
                className="icon-button"
                onClick={() => void loadResources()}
                aria-label="Refresh resources"
              >
                <RefreshCw size={17} className={loading ? "spin" : ""} />
              </button>
            </div>
          </div>

          <div className="resource-table">
            {loading && !resources.length ? (
              <div className="empty-state">
                <LoaderCircle className="spin" size={23} />
                Loading resources...
              </div>
            ) : filteredResources.length ? (
              filteredResources.map((resource) => (
                <article className="resource-row" key={resource.id}>
                  <span className={`resource-icon ${resource.type}`}>
                    <ResourceIcon type={resource.type} />
                  </span>
                  <div className="resource-info">
                    <strong>{resource.name}</strong>
                    <span>
                      {resource.sourceUrl || resource.fileName || "Manual text"}
                    </span>
                  </div>
                  <span className="resource-kind">
                    {resource.type.toUpperCase()}
                  </span>
                  <span className={`resource-status ${resource.status}`}>
                    {resource.status === "ready" && <CheckCircle2 size={14} />}
                    {resource.status === "processing" && (
                      <LoaderCircle className="spin" size={14} />
                    )}
                    {resource.status === "failed" && <XCircle size={14} />}
                    {resource.status}
                  </span>
                  <span className="resource-meta">
                    {resource.status === "ready"
                      ? `${resource.chunkCount} passages`
                      : resource.error || "Processing"}
                  </span>
                  <span className="resource-date">
                    {formatDate(resource.createdAt)}
                  </span>
                  <button
                    className="delete-button"
                    onClick={() => void deleteResource(resource)}
                    disabled={deletingId === resource.id}
                    aria-label={`Delete ${resource.name}`}
                  >
                    {deletingId === resource.id ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : (
                      <Trash2 size={17} />
                    )}
                  </button>
                </article>
              ))
            ) : (
              <div className="empty-state">
                <span className="empty-icon">
                  <BookOpen size={23} />
                </span>
                <strong>
                  {search ? "No matching resources" : "No resources yet"}
                </strong>
                <span>
                  {search
                    ? "Try a different search term."
                    : "Add a web page, document, or text above to get started."}
                </span>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
