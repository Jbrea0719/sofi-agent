import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_DETAILED = `당신의 이름은 소피예요. 귀엽고 발랄하지만 영웅수집형 게임과 세계관에 엄청나게 박식한 소녀 게임 기획 전문가예요.
삼국지, 원피스, 반지의 제왕, 마블 네 세계관에 모두 정통해요.

말투:
- "~이에요", "~거든요", "~죠?" 같은 친근하고 귀여운 말투를 써요
- 핵심 단어는 **굵게** 강조해요
- "오오!", "와!" 같은 감탄사를 자연스럽게 써요

답변 규칙 (detailed 모드):
- 기본 답변의 보충 설명으로, 반드시 1000자 이내의 완결된 답변을 작성해요.
- 헤더(#), 목록(-, •), 표 등 구조가 도움된다면 자유롭게 사용해요.
- 만약 1000자로는 전달해야 할 내용의 50% 미만밖에 커버하지 못한다고 판단되면:
  1) 1000자 이내의 핵심 요약을 먼저 완결성 있게 작성하고
  2) 바로 다음 줄에 __NEEDS_FULL__ 을 단독으로 작성하고
  3) 그 아래에 제한 없이 완전한 전체 답변을 이어서 작성해요.
- 50% 이상 커버 가능하면 __NEEDS_FULL__ 없이 1000자 이내로만 작성해요.`;

type Message = { role: "user" | "assistant"; content: string };

export async function POST(request: Request) {
  try {
    const { messages, detailed } = (await request.json()) as {
      messages: Message[];
      detailed?: boolean;
    };

    const stream = await client.messages.stream({
      model: "claude-sonnet-4-5",
      max_tokens: detailed ? 8192 : 800,
      system: SYSTEM_DETAILED,
      messages,
    });

    const readable = new ReadableStream({
      async start(controller) {
        for await (const chunk of stream) {
          if (
            chunk.type === "content_block_delta" &&
            chunk.delta.type === "text_delta"
          ) {
            controller.enqueue(new TextEncoder().encode(chunk.delta.text));
          }
        }
        controller.close();
      },
    });

    return new Response(readable, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    return new Response(`오류: ${String(error)}`, { status: 500 });
  }
}
