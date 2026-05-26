import Anthropic from "@anthropic-ai/sdk";
import { tavily } from "@tavily/core";
import { supabase } from "@/lib/supabase";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── 세계관 정보 ──
const UNIVERSE_BASE = {
  삼국지: `삼국지: 정사 진수의 삼국지와 나관중의 삼국지연의에 등장하는 인물, 전투, 책략, 시대 배경에 정통합니다.`,
  원피스: `원피스: 악마의 열매, 패기(하키), 4황, 7무해대, 공백의 100년 등 모든 설정에 정통합니다.`,
  반지의제왕: `반지의 제왕: 톨킨의 반지의 제왕, 호빗, 실마릴리온의 인물, 종족, 마법, 역사에 정통합니다.`,
  마블: `마블: MCU 및 코믹스의 모든 히어로/빌런 능력치, 스토리, 설정에 정통합니다.`,
};

const UNIVERSE_TEXT = Object.values(UNIVERSE_BASE).join("\n");

// ── Tavily 검색 ──
async function runSearch(query: string): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return `[시뮬레이션] "${query}" 검색 결과`;
  try {
    const tv = tavily({ apiKey });
    const res = await tv.search(query, { maxResults: 8, searchDepth: "advanced", includeAnswer: true });
    const answer = res.answer ? `요약: ${res.answer}\n\n` : "";
    const results = res.results
      .map((r, i) => `${i + 1}. ${r.title}\n${r.content?.slice(0, 300)}`)
      .join("\n\n");
    return answer + results;
  } catch (err) {
    return `검색 오류: ${String(err)}`;
  }
}

// ════════════════════════════════════════
// 에이전트 1: 검색 에이전트
// 역할: 질문과 지적 사항을 바탕으로 필요한 정보를 검색
// ════════════════════════════════════════
async function searchAgent(
  userQuery: string,
  critique: string,
  round: number
): Promise<string> {
  const prompt = round === 0
    ? `다음 질문에 답하기 위해 필요한 검색어 3개를 뽑아서 각각 검색해줘.\n질문: ${userQuery}`
    : `이전 답변에 대해 다음과 같은 지적이 있었어:\n${critique}\n\n원래 질문: ${userQuery}\n\n지적된 부분을 보완하기 위해 추가로 필요한 정보를 검색해줘.`;

  const tools: Anthropic.Tool[] = [{
    name: "search",
    description: "정보를 검색합니다",
    input_schema: {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  }];

  let messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  let allResults = "";

  for (let turn = 0; turn < 5; turn++) {
    const res = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2048,
      system: "당신은 검색 전문 에이전트예요. 주어진 질문에 필요한 정보를 찾기 위해 여러 번 검색해서 충분한 원본 데이터를 수집해요. 한국어와 영어로 모두 검색하세요.",
      tools,
      messages,
    });

    if (res.stop_reason === "end_turn") break;

    if (res.stop_reason === "tool_use") {
      const toolBlocks = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      messages.push({ role: "assistant", content: res.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tb of toolBlocks) {
        const query = (tb.input as { query: string }).query;
        const result = await runSearch(query);
        allResults += `\n[검색: ${query}]\n${result}\n`;
        toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: result });
      }
      messages.push({ role: "user", content: toolResults });
    } else {
      break;
    }
  }

  return allResults;
}

// ════════════════════════════════════════
// 에이전트 2: 정리 에이전트
// 역할: 검색 결과를 읽기 좋게 구조화하고 요약
// ════════════════════════════════════════
async function summaryAgent(
  userQuery: string,
  searchResults: string
): Promise<string> {
  const res = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 2048,
    system: `당신은 영웅수집형 게임 기획을 위한 정보 정리 전문 에이전트예요.
${UNIVERSE_TEXT}
수집된 검색 결과를 게임 기획자가 바로 활용할 수 있도록 아래 구조로 정리해요:

**[원작 핵심 정보]** — 캐릭터 능력, 성격, 주요 에피소드, 명장면
**[영웅 카드 잠재력]** — 고유 스킬 정체성, 비주얼 컨셉, 포지션(탱커/딜러/서포터 등) 제안
**[게임 스토리 활용 포인트]** — 다른 영웅과의 관계, 라이벌/동료 구도, 성장 서사
**[글로벌 유저 공감 요소]** — 보편적 감정(복수, 희생, 우정 등)과 연결되는 요소
**[기획 시 주의사항]** — 원작 팬덤 반응 예상, 라이선스 고려사항, 유사 게임 사례

- 출처가 불분명한 내용은 "(추정)" 으로 표시해요
- 답변은 한국어로 작성해요`,
    messages: [{
      role: "user",
      content: `질문: ${userQuery}\n\n수집된 정보:\n${searchResults}\n\n위 정보를 바탕으로 질문에 대한 답변을 정리해줘.`
    }],
  });

  return res.content.filter(b => b.type === "text").map(b => (b as Anthropic.TextBlock).text).join("");
}

// ════════════════════════════════════════
// 에이전트 3: 지적 에이전트
// 역할: 정리된 답변의 부족한 점, 오류, 보완이 필요한 부분을 날카롭게 지적
// ════════════════════════════════════════
async function criticAgent(
  userQuery: string,
  summary: string
): Promise<{ approved: boolean; feedback: string }> {
  const res = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: `당신은 글로벌 영웅수집형 모바일 게임 전문 스토리 디렉터예요.
니케, 레이드: 섀도우 레전드, 서머너즈워, 드래곤볼 도칸배틀, 세븐나이츠 등 성공한 영웅수집형 게임의 스토리 구조와 설계 원리에 정통해요.

[검토 기준 1] 영웅화 가능성
- 이 캐릭터/소재를 고유한 영웅 카드로 만들 수 있는가?
- 차별화된 스킬 정체성, 아이덴티티, 비주얼 컨셉으로 발전시킬 수 있는가?

[검토 기준 2] 영웅수집형 장르 적합성
- 해당 내용이 수집·육성·전략의 재미와 연결되는가?
- PvP, 길드전, 레이드 등 핵심 콘텐츠에서 활용 가능한 서사인가?

[검토 기준 3] 게임 스토리 활용도
- 단순 원작 재현이 아닌, 게임만의 오리지널 서사로 확장 가능한가?
- 영웅 간 관계(라이벌, 동료, 숙적), 성장 서사, 비극/희생 요소가 있는가?
- 글로벌 유저가 감정이입할 수 있는 보편적 갈등 구조를 담고 있는가?

[검토 기준 4] 정보 완성도
- 게임 기획에 실제로 활용하기에 정보가 충분히 구체적인가?
- 출처 불명의 추측성 내용이 섞여 있지 않은가?

판정 기준:
- 4가지 기준을 모두 충족하면 첫 줄에 반드시 "APPROVED" 라고 써요
- 하나라도 부족하면 첫 줄에 "NEEDS_IMPROVEMENT" 라고 쓰고,
  어떤 기준이 부족한지 + 어떤 정보를 추가로 찾아야 하는지 구체적으로 적어요`,
    messages: [{
      role: "user",
      content: `원래 질문: ${userQuery}\n\n정리된 답변:\n${summary}\n\n영웅수집형 게임 스토리 디렉터 관점에서 이 답변을 검토해줘.`
    }],
  });

  const feedback = res.content.filter(b => b.type === "text").map(b => (b as Anthropic.TextBlock).text).join("");
  const approved = feedback.trim().startsWith("APPROVED");
  return { approved, feedback };
}

// ════════════════════════════════════════
// 멀티 에이전트 파이프라인
// 검색 → 정리 → 지적 → (필요시 재검색) → 최종 답변
// ════════════════════════════════════════
async function runMultiAgentPipeline(
  userQuery: string,
  onChunk: (text: string) => void,
  detailed = false
): Promise<string> {
  let critique = "";
  let finalSummary = "";

  for (let round = 0; round < 2; round++) {
    const roundLabel = round === 0 ? "1차" : "2차 (보완)";

    // 에이전트 1: 검색
    onChunk(`\n🔍 **[${roundLabel}] 검색 에이전트** 작동 중...\n`);
    const searchResults = await searchAgent(userQuery, critique, round);
    onChunk(`✅ 검색 완료\n\n`);

    // 에이전트 2: 정리
    onChunk(`📝 **[${roundLabel}] 정리 에이전트** 작동 중...\n`);
    const summary = await summaryAgent(userQuery, searchResults);
    onChunk(`✅ 정리 완료\n\n`);

    // 에이전트 3: 지적
    onChunk(`🔎 **[${roundLabel}] 검토 에이전트** 검토 중...\n`);
    const { approved, feedback } = await criticAgent(userQuery, summary);

    if (approved) {
      onChunk(`✅ 검토 통과! 최종 답변을 드릴게요\n\n---\n\n`);
      finalSummary = summary;
      break;
    } else {
      onChunk(`⚠️ 보완 필요 — 추가 검색 시작\n\n`);
      critique = feedback;
      finalSummary = summary; // 마지막 라운드면 이걸 씀
    }
  }

  // 소피 말투로 최종 답변 변환
  onChunk(`💬 **소피가 정리한 최종 답변:**\n\n`);
  const finalRes = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: detailed ? 8192 : 800,
    system: detailed
      ? `당신의 이름은 소피예요. 귀엽고 발랄하지만 영웅수집형 게임과 세계관에 엄청나게 박식한 소녀 게임 기획 전문가예요.
- "~이에요", "~거든요", "~죠?" 같은 친근하고 귀여운 말투를 써요
- 핵심 단어는 **굵게** 강조해요
- "오오!", "와!" 같은 감탄사를 자연스럽게 써요
- 기본 답변의 보충 설명으로, 내용을 완전히 마무리해주세요.
- 헤더(#), 목록(-, •), 표 등 구조가 도움된다면 자유롭게 사용하세요.`
      : `당신의 이름은 소피예요. 귀엽고 발랄하지만 영웅수집형 게임과 세계관에 엄청나게 박식한 소녀 게임 기획 전문가예요.
- "~이에요", "~거든요", "~죠?" 같은 친근하고 귀여운 말투를 써요
- 핵심 단어는 **굵게** 강조해요
- "오오!", "와!" 같은 감탄사를 자연스럽게 써요
- 헤더(#)나 목록(-, •, 번호) 없이 순수 대화체로만 답해요.
- 1~3문장으로 핵심만 전달해요.
- 답변이 길어질 것 같으면 스스로 잘라서 "자세한 내용은 ▼ 자세한 답변 보기에서 이어서 확인하세요!" 로 마무리해요.`,
    messages: [{
      role: "user",
      content: `다음 내용을 소피의 말투로 자연스럽게 전달해줘:\n\n${finalSummary}`
    }],
  });

  const finalText = finalRes.content
    .filter(b => b.type === "text")
    .map(b => (b as Anthropic.TextBlock).text)
    .join("");

  onChunk(finalText);
  return finalText;
}

// ── POST 핸들러 ──
type Message = { role: "user" | "assistant"; content: string };

export async function POST(request: Request) {
  try {
    const { messages, session_id, pair_id, detailed } = (await request.json()) as {
      messages: Message[];
      session_id?: string;
      pair_id?: string;
      detailed?: boolean;
    };

    const userMessage = messages[messages.length - 1];

    const readable = new ReadableStream({
      async start(controller) {
        const encode = (text: string) =>
          controller.enqueue(new TextEncoder().encode(text));
        try {
          const assistantText = await runMultiAgentPipeline(userMessage.content, encode, detailed);
          if (session_id && pair_id) {
            await supabase.from("messages").insert([
              { session_id, pair_id, role: "user", content: userMessage.content, universes: "전체", is_deleted: false },
              { session_id, pair_id, role: "assistant", content: assistantText, universes: "전체", is_deleted: false },
            ]);
          }
        } catch (err) {
          encode(`오류가 발생했어요: ${String(err)}`);
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    return new Response(`오류: ${String(error)}`, { status: 500 });
  }
}
