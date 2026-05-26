import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  try {
    const { content } = (await request.json()) as { content: string };
    const res = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 30,
      messages: [{
        role: "user",
        content: `다음 텍스트의 핵심 내용을 한국어 명사형으로 10자 이내로 요약해줘. 제목만 출력하고 다른 말은 절대 하지 마.\n\n${content.slice(0, 500)}`,
      }],
    });
    const raw = res.content.filter(b => b.type === "text").map(b => (b as Anthropic.TextBlock).text).join("").trim();
    const title = raw.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_").slice(0, 10);
    return Response.json({ title });
  } catch {
    return Response.json({ title: "소피_답변" });
  }
}
