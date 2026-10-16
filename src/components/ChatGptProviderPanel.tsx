import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Loader2 } from "./icons";
import ModelCardList from "./ui/ModelCardList";
import { REASONING_PROVIDERS } from "../models/ModelRegistry";
import { getRemoteProviderIcon } from "../utils/providerIcons";
import type { ChatGptAuthStatus, ChatGptModel } from "../types/electron";

interface ChatGptProviderPanelProps {
  selectedModel: string;
  onModelSelect: (modelId: string) => void;
}

const SIGN_IN_ERROR_KEYS: Record<string, string> = {
  chatgpt_port_busy: "reasoning.chatgpt.portBusy",
  oauth_timeout: "reasoning.chatgpt.timedOut",
};

// "ChatGPT (subscription)" provider: OAuth sign-in instead of an API key, and
// the models the signed-in plan lists (registry fallback while signed out).
export default function ChatGptProviderPanel({
  selectedModel,
  onModelSelect,
}: ChatGptProviderPanelProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ChatGptAuthStatus | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [liveModels, setLiveModels] = useState<ChatGptModel[] | null>(null);
  const [modelsFallback, setModelsFallback] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    window.electronAPI
      ?.chatgptAuthStatus?.()
      .then((next) => mountedRef.current && setStatus(next))
      .catch(() => mountedRef.current && setStatus({ signedIn: false }));
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const signedIn = !!status?.signedIn;

  useEffect(() => {
    if (!signedIn) {
      setLiveModels(null);
      setModelsFallback(false);
      return;
    }
    setLoadingModels(true);
    window.electronAPI
      ?.chatgptListModels?.()
      .then((result) => {
        if (!mountedRef.current || !result) return;
        setLiveModels(result.models);
        setModelsFallback(result.fallback);
      })
      .catch(() => mountedRef.current && setModelsFallback(true))
      .finally(() => mountedRef.current && setLoadingModels(false));
  }, [signedIn]);

  const handleSignIn = useCallback(async () => {
    setErrorKey(null);
    setSigningIn(true);
    try {
      const result = await window.electronAPI?.chatgptSignIn?.();
      if (!mountedRef.current || !result) return;
      if (result.success) {
        setStatus({ signedIn: true, email: result.email ?? null, plan: result.plan ?? null });
      } else if (result.code !== "oauth_cancelled") {
        setErrorKey(
          (result.code && SIGN_IN_ERROR_KEYS[result.code]) || "reasoning.chatgpt.signInFailed"
        );
      }
    } catch {
      if (mountedRef.current) setErrorKey("reasoning.chatgpt.signInFailed");
    } finally {
      if (mountedRef.current) setSigningIn(false);
    }
  }, []);

  const handleCancel = useCallback(() => {
    window.electronAPI?.chatgptCancelSignIn?.().catch(() => {});
  }, []);

  const handleSignOut = useCallback(async () => {
    setErrorKey(null);
    await window.electronAPI?.chatgptSignOut?.().catch(() => {});
    if (mountedRef.current) setStatus({ signedIn: false });
  }, []);

  const modelOptions = useMemo(() => {
    const { icon, invertInDark } = getRemoteProviderIcon("chatgpt");
    const registryModels = REASONING_PROVIDERS.chatgpt?.models ?? [];
    const describe = (id: string) => {
      const known = registryModels.find((model) => model.value === id);
      if (!known) return undefined;
      return known.descriptionKey
        ? t(known.descriptionKey, { defaultValue: known.description })
        : known.description;
    };
    const source = liveModels
      ? liveModels.map((model) => ({ value: model.id, label: model.name }))
      : registryModels.map((model) => ({ value: model.value, label: model.label }));
    return source.map((model) => ({
      ...model,
      description: describe(model.value),
      icon,
      invertInDark,
    }));
  }, [liveModels, t]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("reasoning.chatgpt.description")}</p>

      <div className="rounded-lg border border-border bg-surface-1 p-3 dark:border-white/10 dark:bg-white/3">
        {status === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : signedIn ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {status.email
                  ? t("reasoning.chatgpt.signedInAs", { email: status.email })
                  : t("reasoning.chatgpt.signedIn")}
              </p>
              {status.plan && (
                <p className="text-xs text-muted-foreground">
                  {t("reasoning.chatgpt.plan", { plan: status.plan })}
                </p>
              )}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={handleSignOut}>
              {t("reasoning.chatgpt.signOut")}
            </Button>
          </div>
        ) : signingIn ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t("reasoning.chatgpt.waiting")}</p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={handleCancel}>
              {t("reasoning.chatgpt.cancel")}
            </Button>
          </div>
        ) : (
          <Button type="button" size="sm" onClick={handleSignIn}>
            {t("reasoning.chatgpt.signIn")}
          </Button>
        )}
        {errorKey && <p className="mt-2 text-xs text-destructive">{t(errorKey)}</p>}
      </div>

      <div className="pt-1 space-y-2">
        <h4 className="text-sm font-medium text-foreground">{t("reasoning.selectModel")}</h4>
        {!signedIn && status !== null && (
          <p className="text-xs text-muted-foreground">
            {t("reasoning.chatgpt.signInToSeeModels")}
          </p>
        )}
        <ModelCardList
          models={modelOptions}
          selectedModel={selectedModel}
          onModelSelect={onModelSelect}
        />
        {loadingModels && (
          <p className="text-xs text-muted-foreground">{t("reasoning.chatgpt.loadingModels")}</p>
        )}
        {!loadingModels && signedIn && modelsFallback && (
          <p className="text-xs text-muted-foreground">{t("reasoning.chatgpt.modelsFallback")}</p>
        )}
      </div>
    </div>
  );
}
