import Anthropic from "@anthropic-ai/sdk";
import { tavily } from "@tavily/core";
import { supabase } from "@/lib/supabase";

// ── 세계관 전문가 정보 ──
const UNIVERSE_BASE = {
  삼국지: `- 삼국지: 정사 진수의 삼국지와 나관중의 삼국지연의에 등장하는 인물, 전투, 책략, 시대 배경에 정통합니다. 역사적 사실과 소설적 각색을 구분해서 답합니다.`,
  원피스: `- 원피스: 오다 에이이치로의 만화 원피스 세계관 전문가입니다. 악마의 열매, 패기(하키), 해군/해적단, 4황, 7무해대, 공백의 100년, 로드 포네그리프 등 원피스의 모든 설정에 정통합니다.`,
  반지의제왕: `- 반지의 제왕: J.R.R. 톨킨의 반지의 제왕 및 호빗, 실마릴리온에 등장하는 인물, 종족, 마법, 역사에 정통합니다.`,
  마블: `- 마블: 마블 코믹스 및 MCU 세계관 전문가입니다. 어벤져스, 스파이더맨, 아이언맨, 토르 등 모든 히어로와 빌런의 능력치, 스토리, 설정에 정통합니다.`,
};

function buildSystemPrompt(detailed?: boolean): string {
  const sections = Object.values(UNIVERSE_BASE).join("\n");

  const lengthGuide = detailed
    ? `- 이전 답변의 근거와 배경을 전문가 관점에서 체계적으로 정리해서 설명하세요.
- A4 2장을 초과하지 않도록 핵심 내용만 간결하게 요약하세요.`
    : `- 세계관을 깊이 아는 전문가가 친구에게 가볍게 설명하듯 답하세요.
- 자연스러운 대화체로 2~3문장 이내로 답하세요.`;

  return `당신의 이름은 소피(Sofi)예요. 삼국지, 원피스, 반지의 제왕, 마블 네 세계관에 모두 정통한 전문가예요.

${sections}

말투 및 성격:
- 당신은 소피예요. 귀엽고 발랄하지만 실제로는 엄청나게 박식한 소녀 전문가예요.
- 답변할 때 핵심 단어나 중요한 문장은 반드시 **굵게** 표시해서 강조해요.
- "~이에요", "~거든요", "~죠?", "~인 거 알아요?" 같은 친근하고 귀여운 말투를 사용해요.
- 신나는 내용엔 "오오!", "와!", "사실 이게 진짜 흥미로운 부분인데요!" 같은 감탄사를 자연스럽게 써요.
- 틀린 내용은 살짝 장난스럽게 "음... 그건 조금 다른데요~?" 하고 정정해줘요.

도구 사용 원칙:
- 확실하지 않은 정보, 최신 내용, 구체적인 사례가 필요하면 반드시 search 도구를 사용해요.
- 검색 결과를 바탕으로 더 정확하고 풍부하게 답해요.

답변 원칙:
- 어떤 세계관 질문이든 자신 있게 답하세요.
- 세계관을 넘나드는 크로스오버 질문에도 적극적으로 답해주세요.
${lengthGuide}`;
}

// ── Tavily 검색 도구 정의 ──
const tools: Anthropic.Tool[] = [
  {
    name: "search",
    description:
      "삼국지·원피스·반지의제왕·마블 최신 정보, 인물 상세, 전투 기록, 설정 등을 검색합니다. 확실하지 않은 정보나 구체적인 사례가 필요할 때 사용하세요.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "검색할 키워드 (예: '조조 관도대전', '루피 기어5', '간달프 능력')",
        },
      },
      required: ["query"],
    },
  },
];

// ── Tavily 검색 실행 ──
async function runSearch(query: string): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return `[검색 시뮬레이션] "${query}" 결과: 해당 키워드에 대한 세계관 정보가 검색되었습니다.`;
  }
  try {
    const client = tavily({ apiKey });
    const response = await client.search(query, { maxResults: 5, searchDepth: "basic" });
    return response.results
      .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.content?.slice(0, 200)}`)
      .join("\n\n");
  } catch (err) {
    return `검색 오류: ${String(err)}`;
  }
}

// ── tool_use 루프 (에이전트 핵심) ──
async function runAgentLoop(
  messages: Anthropic.MessageParam[],
  systemPrompt: string,
  maxTokens: number,
  onChunk: (text: string) => void
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let currentMessages = [...messages];
  let fullText = "";

  for (let turn = 0; turn < 5; turn++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: maxTokens,
      system: systemPrompt,
      tools,
      messages: currentMessages,
    });

    for (const block of response.content) {
      if (block.type === "text") {
        onChunk(block.text);
        fullText += block.text;
      }
    }

    if (response.stop_reason === "end_turn") break;

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      currentMessages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolBlock of toolUseBlocks) {
        const query = (toolBlock.input as { query: string }).query;
        onChunk(`\n🔍 **검색 중**: ${query}\n\n`);
        const result = toolBlock.name === "search"
          ? await runSearch(query)
          : "알 수 없는 도구예요.";
        toolResults.push({ type: "tool_result", tool_use_id: toolBlock.id, content: result });
      }
      currentMessages.push({ role: "user", content: toolResults });
    }
  }
  return fullText;
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

    const systemPrompt = buildSystemPrompt(detailed);
    const maxTokens = detailed ? 4096 : 1024;
    const userMessage = messages[messages.length - 1];

    const readable = new ReadableStream({
      async start(controller) {
        const encode = (text: string) =>
          controller.enqueue(new TextEncoder().encode(text));
        try {
          const assistantText = await runAgentLoop(messages, systemPrompt, maxTokens, encode);
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
