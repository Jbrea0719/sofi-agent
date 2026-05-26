"use client";

import { useState, useRef, useEffect, KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";

type Message = {
  role: "user" | "assistant";
  content: string;
  pair_id?: string;
  is_deleted?: boolean;
};

type MessagePair = {
  pair_id: string;
  user: Message;
  assistant: Message;
  is_deleted: boolean;
  detail_content?: string;
  detail_loading?: boolean;
  detail_shown?: boolean;
  timestamp?: string;
};

function getTime() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "오후" : "오전";
  const hour = h % 12 || 12;
  return `${ampm} ${hour}:${m}`;
}

const GOLD = "#d4af37";
const GOLD_DIM = "rgba(212,175,55,0.5)";
const GOLD_FAINT = "rgba(212,175,55,0.15)";

function fixMarkdown(text: string): string {
  return text
    .replace(/\*\*"([^"]+)"\*\*/g, "**$1**")
    .replace(/\*\*'([^']+)'\*\*/g, "**$1**");
}

export default function ChatPage() {
  const [pairs, setPairs] = useState<MessagePair[]>([]);
  const [streamingPair, setStreamingPair] = useState<{ user: string; assistant: string } | null>(null);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [nicknameInput, setNicknameInput] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("agent_nickname");
    if (saved) setSessionId("agent:" + saved);
    else setShowModal(true);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/messages?session_id=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.messages?.length > 0) setPairs(groupIntoPairs(data.messages));
      })
      .catch(() => {});
  }, [sessionId]);

  useEffect(() => { scrollToBottom(); }, [pairs, streamingPair]);

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
  }

  function groupIntoPairs(messages: Message[]): MessagePair[] {
    const pairMap = new Map<string, { user?: Message; assistant?: Message; is_deleted: boolean }>();
    const order: string[] = [];
    for (const msg of messages) {
      const pid = msg.pair_id ?? "unknown";
      if (!pairMap.has(pid)) { pairMap.set(pid, { is_deleted: msg.is_deleted ?? false }); order.push(pid); }
      const entry = pairMap.get(pid)!;
      if (msg.role === "user") entry.user = msg;
      else entry.assistant = msg;
      if (msg.is_deleted) entry.is_deleted = true;
    }
    return order.map((pid) => {
      const entry = pairMap.get(pid)!;
      if (!entry.user || !entry.assistant) return null;
      return { pair_id: pid, user: entry.user, assistant: entry.assistant, is_deleted: entry.is_deleted };
    }).filter(Boolean) as MessagePair[];
  }

  function confirmNickname() {
    const trimmed = nicknameInput.trim();
    if (!trimmed) return;
    localStorage.setItem("agent_nickname", trimmed);
    setSessionId("agent:" + trimmed);
    setShowModal(false);
  }

  async function sendMessage() {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    const pairId = crypto.randomUUID();
    const time = getTime();
    const allMessages = [
      ...pairs.filter(p => !p.is_deleted).flatMap(p => [
        { role: p.user.role, content: p.user.content },
        { role: p.assistant.role, content: p.assistant.content },
      ]),
      { role: "user" as const, content: trimmed },
    ];
    setStreamingPair({ user: trimmed, assistant: "" });
    setInput("");
    setIsLoading(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: allMessages, session_id: sessionId, pair_id: pairId }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("오류");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        assistantText += decoder.decode(value);
        setStreamingPair({ user: trimmed, assistant: assistantText });
      }
      setPairs((prev) => [...prev, {
        pair_id: pairId,
        user: { role: "user", content: trimmed, pair_id: pairId },
        assistant: { role: "assistant", content: assistantText, pair_id: pairId },
        is_deleted: false,
        timestamp: time,
      }]);
      setStreamingPair(null);
    } catch {
      // AbortError면 조용히 처리 (버튼에서 이미 처리함)
    } finally {
      abortControllerRef.current = null;
      setIsLoading(false);
    }
  }

  // 질문 실수: 답변 중단 + 질문·답변 모두 삭제
  function cancelAndDiscard() {
    abortControllerRef.current?.abort();
    setStreamingPair(null);
    setInput("");
  }

  // 질문 수정: 답변 중단 + 질문을 입력창에 복원
  function cancelAndEdit() {
    const question = streamingPair?.user ?? "";
    abortControllerRef.current?.abort();
    setStreamingPair(null);
    setInput(question);
  }

  async function loadDetail(pairId: string) {
    const pair = pairs.find((p) => p.pair_id === pairId);
    if (!pair) return;
    if (pair.detail_content) {
      setPairs((prev) => prev.map((p) => p.pair_id === pairId ? { ...p, detail_shown: !p.detail_shown } : p));
      return;
    }
    setPairs((prev) => prev.map((p) => p.pair_id === pairId ? { ...p, detail_loading: true, detail_shown: true } : p));
    try {
      const context = [
        ...pairs.filter(p => !p.is_deleted && p.pair_id !== pairId).flatMap(p => [
          { role: p.user.role, content: p.user.content },
          { role: p.assistant.role, content: p.assistant.content },
        ]),
        { role: "user" as const, content: pair.user.content },
        { role: "assistant" as const, content: pair.assistant.content },
        { role: "user" as const, content: "위 답변을 더 자세하고 풍부하게 설명해줘." },
      ];
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: context, detailed: true }),
      });
      if (!response.ok || !response.body) throw new Error("오류");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
        setPairs((prev) => prev.map((p) => p.pair_id === pairId ? { ...p, detail_content: text } : p));
      }
    } catch {
      setPairs((prev) => prev.map((p) => p.pair_id === pairId ? { ...p, detail_content: "오류가 발생했습니다." } : p));
    } finally {
      setPairs((prev) => prev.map((p) => p.pair_id === pairId ? { ...p, detail_loading: false } : p));
    }
  }

  async function deletePair(pairId: string) {
    setPairs((prev) => prev.map((p) => p.pair_id === pairId ? { ...p, is_deleted: true } : p));
    await fetch("/api/messages", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pair_id: pairId, is_deleted: true }) });
  }

  async function restorePair(pairId: string) {
    setPairs((prev) => prev.map((p) => p.pair_id === pairId ? { ...p, is_deleted: false } : p));
    await fetch("/api/messages", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pair_id: pairId, is_deleted: false }) });
  }

  async function permanentDeletePair(pairId: string) {
    setPairs((prev) => prev.filter((p) => p.pair_id !== pairId));
    await fetch("/api/messages", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pair_id: pairId }) });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && e.altKey) {
      // Alt+Enter → 줄바꿈
      e.preventDefault();
      setInput((prev) => prev + "\n");
    } else if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      // Enter → 전송
      e.preventDefault();
      sendMessage();
    }
  }

  const activePairs = pairs.filter((p) => !p.is_deleted);
  const deletedPairs = pairs.filter((p) => p.is_deleted);

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: "linear-gradient(160deg, #0d0d1a 0%, #1a0d2e 50%, #0d1a1a 100%)" }}>

      {showModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="rounded-2xl p-8 w-80 shadow-2xl" style={{ backgroundColor: "#1a1a2e", border: `1px solid ${GOLD_FAINT}` }}>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0" style={{ backgroundColor: GOLD_FAINT, border: `1px solid ${GOLD_DIM}` }}>
                <img src="/avatar.png" alt="소피" className="w-full h-full object-cover" />
              </div>
              <h2 className="text-base font-bold" style={{ color: GOLD }}>입장하기</h2>
            </div>
            <p className="text-xs mb-4" style={{ color: GOLD_DIM }}>닉네임을 입력하면 대화 기록이 저장됩니다</p>
            <input value={nicknameInput} onChange={(e) => setNicknameInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && confirmNickname()}
              placeholder="닉네임 입력" autoComplete="off"
              className="w-full px-4 py-2.5 rounded-xl text-sm mb-4 outline-none"
              style={{ backgroundColor: "rgba(255,255,255,0.05)", border: `1px solid ${GOLD_FAINT}`, color: "#e8e0d0" }}
              autoFocus />
            <button onClick={confirmNickname} disabled={!nicknameInput.trim()}
              className="w-full py-2.5 rounded-xl text-sm font-bold disabled:opacity-40"
              style={{ backgroundColor: GOLD, color: "#0d0d1a" }}>입장하기</button>
          </div>
        </div>
      )}

      <header className="px-6 py-4 flex items-center gap-4" style={{ backgroundColor: "rgba(0,0,0,0.4)", borderBottom: `1px solid ${GOLD_FAINT}` }}>
        <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: GOLD_FAINT, border: `1px solid ${GOLD_DIM}`, boxShadow: `0 0 15px rgba(212,175,55,0.3)` }}>
          <img src="/avatar.png" alt="소피" className="w-full h-full object-cover rounded-full" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <p className="font-bold text-sm" style={{ color: GOLD }}>소피 (에이전트)</p>
            <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: "rgba(52,211,153,0.15)", border: "1px solid rgba(52,211,153,0.3)", color: "#34d399" }}>🔍 검색 가능</span>
          </div>
          <p className="text-xs" style={{ color: GOLD_DIM }}>세계관 덕후 : 삼국지 + 원피스 + 반지의 제왕 + 마블</p>
        </div>
        {sessionId && (
          <div className="ml-auto">
            <span className="text-xs px-3 py-1 rounded-full" style={{ backgroundColor: GOLD_FAINT, border: `1px solid rgba(212,175,55,0.3)`, color: GOLD }}>{sessionId.replace(/^agent:/, "")}</span>
          </div>
        )}
      </header>

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-6" style={{ scrollbarWidth: "thin", scrollbarColor: `${GOLD_DIM} transparent` }}>
        <div className="max-w-2xl mx-auto space-y-6">

          {activePairs.length === 0 && !streamingPair && (
            <div className="text-center mt-20">
              <div className="w-16 h-16 rounded-full mx-auto flex items-center justify-center mb-4" style={{ backgroundColor: GOLD_FAINT, border: `1px solid ${GOLD_DIM}` }}>
                <img src="/avatar.png" alt="소피" className="w-full h-full object-cover rounded-full" />
              </div>
              <p className="text-sm font-medium" style={{ color: GOLD }}>소피 (에이전트 버전)</p>
              <p className="text-xs mt-1" style={{ color: GOLD_DIM }}>삼국지 · 원피스 · 반지의 제왕 · 마블 — 무엇이든 물어보세요</p>
              <p className="text-xs mt-3 px-4 py-2 rounded-full inline-block" style={{ backgroundColor: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.2)", color: "#34d399" }}>
                🔍 모르는 내용은 실시간으로 검색해서 답해요
              </p>
            </div>
          )}

          {activePairs.map((pair) => (
            <div key={pair.pair_id} className="space-y-3 group">
              <div className="flex justify-end items-end gap-2">
                <div className="flex flex-col items-end gap-1">
                  <button onClick={() => deletePair(pair.pair_id)} className="opacity-0 group-hover:opacity-100 transition-opacity text-xs" style={{ color: GOLD_DIM }}>삭제</button>
                  {pair.timestamp && <span className="text-xs" style={{ color: GOLD_DIM }}>{pair.timestamp}</span>}
                </div>
                <div className="max-w-[70%] px-4 py-3 rounded-2xl rounded-tr-sm text-sm font-medium" style={{ backgroundColor: GOLD, color: "#0d0d1a", boxShadow: `0 4px 15px rgba(212,175,55,0.25)` }}>
                  {pair.user.content}
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: GOLD_FAINT, border: `1px solid ${GOLD_DIM}` }}>
                  <img src="/avatar.png" alt="소피" className="w-full h-full object-cover rounded-full" />
                </div>
                <div className="flex flex-col gap-1 max-w-[75%]">
                  <p className="text-xs ml-1" style={{ color: GOLD }}>소피</p>
                  <div className="px-4 py-3 rounded-2xl rounded-tl-sm text-sm prose prose-sm max-w-none" style={{ backgroundColor: "rgba(255,255,255,0.05)", border: `1px solid ${GOLD_FAINT}`, color: "#e8e0d0", backdropFilter: "blur(10px)" }}>
                    <ReactMarkdown>{fixMarkdown(pair.assistant.content)}</ReactMarkdown>
                  </div>
                  <button onClick={() => loadDetail(pair.pair_id)} className="text-xs ml-1 flex items-center gap-1 w-fit" style={{ color: GOLD_DIM }}>
                    {pair.detail_loading ? "⏳ 불러오는 중..." : pair.detail_shown ? "▲ 접기" : "▼ 자세한 답변 보기"}
                  </button>
                  {pair.detail_shown && pair.detail_content && (
                    <div className="px-4 py-3 rounded-2xl text-sm prose prose-sm max-w-none" style={{ backgroundColor: "rgba(212,175,55,0.07)", border: `1px solid rgba(212,175,55,0.25)`, color: "#e8e0d0" }}>
                      <ReactMarkdown>{fixMarkdown(pair.detail_content)}</ReactMarkdown>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}

          {streamingPair && (
            <div className="space-y-3">
              <div className="flex justify-end items-end gap-2">
                <div className="flex flex-col gap-1 items-end">
                  <div className="flex gap-2">
                    <button
                      onClick={cancelAndEdit}
                      className="text-xs px-3 py-1 rounded-full font-medium transition-opacity hover:opacity-80"
                      style={{ backgroundColor: "rgba(212,175,55,0.15)", border: `1px solid ${GOLD_DIM}`, color: GOLD }}>
                      ✏️ 질문 수정
                    </button>
                    <button
                      onClick={cancelAndDiscard}
                      className="text-xs px-3 py-1 rounded-full font-medium transition-opacity hover:opacity-80"
                      style={{ backgroundColor: "rgba(255,80,80,0.12)", border: "1px solid rgba(255,80,80,0.35)", color: "#f87171" }}>
                      🗑️ 질문 실수
                    </button>
                  </div>
                </div>
                <div className="max-w-[70%] px-4 py-3 rounded-2xl rounded-tr-sm text-sm font-medium" style={{ backgroundColor: GOLD, color: "#0d0d1a" }}>
                  {streamingPair.user}
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: GOLD_FAINT, border: `1px solid ${GOLD_DIM}` }}>
                  <img src="/avatar.png" alt="소피" className="w-full h-full object-cover rounded-full" />
                </div>
                <div className="flex flex-col gap-1 max-w-[75%]">
                  <p className="text-xs ml-1" style={{ color: GOLD }}>소피</p>
                  <div className="px-4 py-3 rounded-2xl rounded-tl-sm text-sm prose prose-sm max-w-none" style={{ backgroundColor: "rgba(255,255,255,0.05)", border: `1px solid ${GOLD_FAINT}`, color: "#e8e0d0" }}>
                    {streamingPair.assistant
                      ? <ReactMarkdown>{fixMarkdown(streamingPair.assistant)}</ReactMarkdown>
                      : <span style={{ color: GOLD_DIM }} className="animate-pulse">···</span>}
                  </div>
                </div>
              </div>
            </div>
          )}

          {deletedPairs.length > 0 && (
            <div className="pt-2">
              <button onClick={() => setShowDeleted(!showDeleted)} className="text-xs mx-auto flex items-center gap-1 px-3 py-1 rounded-full" style={{ color: GOLD_DIM, backgroundColor: "rgba(212,175,55,0.07)", border: `1px solid ${GOLD_FAINT}` }}>
                {showDeleted ? "▲" : "▼"} 삭제된 대화 {deletedPairs.length}개
              </button>
              {showDeleted && (
                <div className="space-y-4 mt-3">
                  {deletedPairs.map((pair) => (
                    <div key={pair.pair_id} className="opacity-40 space-y-2">
                      <div className="flex justify-end items-end gap-2">
                        <div className="flex gap-1">
                          <button onClick={() => restorePair(pair.pair_id)} className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: "rgba(212,175,55,0.1)", border: `1px solid ${GOLD_FAINT}`, color: GOLD }}>↩️ 복원</button>
                          <button onClick={() => { if (confirm("영구 삭제할까요?")) permanentDeletePair(pair.pair_id); }} className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: "rgba(255,50,50,0.1)", border: "1px solid rgba(255,50,50,0.2)", color: "#f87171" }}>🗑️ 영구삭제</button>
                        </div>
                        <div className="max-w-[70%] px-4 py-3 rounded-2xl rounded-tr-sm text-sm line-through" style={{ backgroundColor: GOLD, color: "#0d0d1a" }}>
                          {pair.user.content}
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: GOLD_FAINT, border: `1px solid ${GOLD_DIM}` }}>
                          <img src="/avatar.png" alt="소피" className="w-full h-full object-cover rounded-full" />
                        </div>
                        <div className="px-4 py-3 rounded-2xl rounded-tl-sm text-sm max-w-[75%]" style={{ backgroundColor: "rgba(255,255,255,0.05)", border: `1px solid ${GOLD_FAINT}`, color: "#e8e0d0" }}>
                          {pair.assistant.content}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {showScrollBtn && (
        <button onClick={scrollToBottom} className="fixed bottom-24 right-6 w-10 h-10 rounded-full flex items-center justify-center text-base shadow-lg z-40"
          style={{ backgroundColor: GOLD, color: "#0d0d1a", boxShadow: `0 4px 15px rgba(212,175,55,0.4)` }}>↓</button>
      )}

      <div className="px-4 py-3 flex gap-3 items-end" style={{ backgroundColor: "rgba(0,0,0,0.5)", borderTop: `1px solid ${GOLD_FAINT}` }}>
        <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
          placeholder={"질문을 입력하세요... (Enter 전송 / Alt+Enter 줄바꿈)"}
          disabled={isLoading} autoComplete="off" autoCorrect="off" spellCheck={false}
          rows={1}
          className="flex-1 px-4 py-3 rounded-xl text-sm outline-none resize-none"
          style={{
            backgroundColor: "rgba(255,255,255,0.07)",
            border: `1px solid ${GOLD_FAINT}`,
            color: "#e8e0d0",
            maxHeight: "160px",
            overflowY: "auto",
            lineHeight: "1.5",
            scrollbarWidth: "thin",
            scrollbarColor: `${GOLD_DIM} transparent`,
          }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 160) + "px";
          }} />
        <button onClick={sendMessage} disabled={isLoading || !input.trim()}
          className="w-11 h-11 rounded-xl flex items-center justify-center text-base flex-shrink-0 font-bold disabled:opacity-40"
          style={{ backgroundColor: GOLD, color: "#0d0d1a", boxShadow: `0 4px 15px rgba(212,175,55,0.3)` }}>➤</button>
      </div>
    </div>
  );
}
