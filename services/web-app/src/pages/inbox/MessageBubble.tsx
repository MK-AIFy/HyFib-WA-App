import { MapPin } from "lucide-react";
import type { Message, Template } from "@hyfib/shared-core";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { timeAgo, initials } from "@/lib/format";
import { mediaAssetOf } from "@/lib/media";
import {
  contactCardsOf,
  interactivePromptOf,
  interactiveReplyOf,
  locationOf,
  mapsUrl,
  messageKind,
  safeHttpUrl,
  substituteTemplate,
  templateOf,
  type ContactCardInfo,
  type InteractivePrompt,
  type InteractiveReply,
  type LocationInfo,
  type TemplateInfo
} from "@/lib/message-kind";
import { useList } from "@/hooks/use-resource";
import { messageText } from "@/hooks/use-conversations";
import { MediaAttachment } from "./MediaAttachment";

/**
 * One message bubble. Renders media (unchanged) plus a kind-aware body: rich
 * renderers for location / contacts / interactive / template, and the plain
 * `messageText` fallback for text and everything else. Outbound/inbound styling
 * is identical to the pre-refactor inline markup; a failed outbound is flagged
 * because a 24h-window rejection surfaces ONLY here (async, never as a send 4xx).
 */
export function MessageBubble({ message }: { message: Message }) {
  const media = mediaAssetOf(message);
  const outbound = message.direction === "outbound";
  const failed = outbound && message.status === "failed";

  return (
    <div
      className={cn(
        "max-w-[75%] rounded-lg px-3 py-2 text-sm",
        outbound ? "self-end bg-primary/15 text-foreground" : "self-start bg-secondary",
        failed && "border border-destructive/50"
      )}
    >
      {media ? <MediaAttachment media={media} /> : null}
      <MessageBody message={message} />
      <p className="mt-1 text-[10px] text-muted-foreground">
        {timeAgo(message.createdAt)}
        {outbound ? <span className={cn(failed && "font-medium text-destructive")}> · {message.status}</span> : null}
      </p>
      {failed ? (
        <p className="mt-0.5 text-[10px] text-destructive">
          Not delivered — outside the 24h window or rejected by WhatsApp.
        </p>
      ) : null}
    </div>
  );
}

function MessageBody({ message }: { message: Message }) {
  const payload = message.payload;
  switch (messageKind(message)) {
    case "location": {
      const loc = locationOf(payload);
      if (loc) return <LocationBody loc={loc} />;
      break;
    }
    case "contacts": {
      const cards = contactCardsOf(payload);
      if (cards.length > 0) return <ContactsBody cards={cards} />;
      break;
    }
    case "interactive": {
      const prompt = interactivePromptOf(payload);
      if (prompt) return <InteractiveBody prompt={prompt} />;
      const reply = interactiveReplyOf(payload);
      if (reply) return <InteractiveReplyBody reply={reply} message={message} />;
      break;
    }
    case "template": {
      const t = templateOf(payload);
      if (t) return <TemplateBody t={t} />;
      break;
    }
  }
  return <p className="whitespace-pre-wrap break-words">{messageText(message)}</p>;
}

function LocationBody({ loc }: { loc: LocationInfo }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-1.5">
        <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0">
          {loc.name ? <p className="font-medium break-words">{loc.name}</p> : null}
          {loc.address ? <p className="break-words text-muted-foreground">{loc.address}</p> : null}
          {!loc.name && !loc.address ? (
            <p className="text-muted-foreground">
              {loc.latitude}, {loc.longitude}
            </p>
          ) : null}
        </div>
      </div>
      <a
        href={mapsUrl(loc)}
        target="_blank"
        rel="noopener noreferrer"
        className="w-fit font-medium text-primary underline"
      >
        Open in maps
      </a>
    </div>
  );
}

function ContactsBody({ cards }: { cards: ContactCardInfo[] }) {
  return (
    <div className="flex flex-col gap-2">
      {cards.map((card, i) => (
        <div
          key={`${i}-${card.formattedName}`}
          className="flex items-start gap-2 rounded-md border border-border bg-background/50 px-3 py-2"
        >
          <Avatar size="sm">
            <AvatarFallback>{initials(card.formattedName, card.phones[0])}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="font-medium break-words">{card.formattedName}</p>
            {card.phones.map((phone) => (
              <p key={phone} className="break-words text-muted-foreground">
                {phone}
              </p>
            ))}
            {card.emails.map((email) => (
              <p key={email} className="break-words text-muted-foreground">
                {email}
              </p>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function InteractiveBody({ prompt }: { prompt: InteractivePrompt }) {
  return (
    <div className="flex flex-col gap-1.5">
      {prompt.headerText ? <p className="font-medium break-words">{prompt.headerText}</p> : null}
      <p className="whitespace-pre-wrap break-words">{prompt.bodyText}</p>
      {prompt.footerText ? <p className="text-xs text-muted-foreground break-words">{prompt.footerText}</p> : null}
      <InteractiveAffordance prompt={prompt} />
    </div>
  );
}

function InteractiveAffordance({ prompt }: { prompt: InteractivePrompt }) {
  if (prompt.interactiveType === "button" && prompt.buttons?.length) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {prompt.buttons.map((b) => (
          <button
            key={b.id}
            type="button"
            disabled
            className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground"
          >
            {b.title}
          </button>
        ))}
      </div>
    );
  }
  if (prompt.interactiveType === "list") {
    const rows = prompt.sections?.reduce((n, s) => n + (s.rows?.length ?? 0), 0) ?? 0;
    return (
      <span className="inline-flex w-fit items-center rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
        {prompt.buttonLabel ?? "List"} · {rows} option{rows === 1 ? "" : "s"}
      </span>
    );
  }
  if (prompt.interactiveType === "cta_url") {
    const href = safeHttpUrl(prompt.ctaUrl);
    if (href) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="w-fit font-medium text-primary underline">
          {prompt.ctaDisplayText ?? href}
        </a>
      );
    }
    // Unsafe or unparseable URL — render as plain text, never as an anchor.
    return (
      <p className="text-xs text-muted-foreground break-words">
        {prompt.ctaDisplayText ? `${prompt.ctaDisplayText}: ` : ""}
        {typeof prompt.ctaUrl === "string" ? prompt.ctaUrl : ""}
      </p>
    );
  }
  return null;
}

function InteractiveReplyBody({ reply, message }: { reply: InteractiveReply; message: Message }) {
  return (
    <div className="flex flex-col">
      <p className="whitespace-pre-wrap break-words">{reply.title ?? messageText(message)}</p>
      <p className="text-[10px] text-muted-foreground">{reply.label}</p>
    </div>
  );
}

function TemplateBody({ t }: { t: TemplateInfo }) {
  // Same query key + path as TemplatesPage so the template cache is shared: at
  // most one /api/v1/templates fetch app-wide, resolved to the body text here.
  const { data } = useList<Template>(["templates"], "/api/v1/templates");
  const items = data?.items ?? [];
  const match =
    items.find((x) => x.name === t.templateName && x.language === t.templateLanguage) ??
    items.find((x) => x.name === t.templateName);
  const hasParams = Boolean(t.parameters && t.parameters.length > 0);

  return (
    <div className="flex flex-col gap-1.5">
      <Badge variant="outline" className="w-fit">
        Template: {t.templateName} ({t.templateLanguage})
      </Badge>
      {match ? (
        <p className="whitespace-pre-wrap break-words">{substituteTemplate(match.body, t.parameters)}</p>
      ) : hasParams ? (
        <div className="flex flex-wrap gap-1">
          {t.parameters!.map((p, i) => (
            <Badge key={`${i}-${p}`} variant="gray">
              {p}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
