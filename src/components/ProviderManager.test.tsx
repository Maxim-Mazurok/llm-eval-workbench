import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderManager } from "./ProviderManager";

const providers = [{
  id: "openai-main",
  name: "OpenAI main",
  baseUrl: "https://api.openai.com/v1",
  hasApiKey: true
}];

afterEach(cleanup);

describe("ProviderManager", () => {
  it("edits metadata without replacing a saved key when the field stays blank", async () => {
    const onSave = vi.fn(async (input) => ({ ...providers[0], ...input }));
    render(
      <ProviderManager open providers={providers} selectedProviderId="openai-main"
        onClose={vi.fn()} onSelect={vi.fn()} onSave={onSave} onDelete={vi.fn()} />
    );

    await userEvent.clear(screen.getByLabelText("Display name"));
    await userEvent.type(screen.getByLabelText("Display name"), "OpenAI production");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSave).toHaveBeenCalledWith({
      name: "OpenAI production",
      baseUrl: "https://api.openai.com/v1"
    }, "openai-main");
  });

  it("creates a provider with a key and supports explicit key removal", async () => {
    const onSave = vi.fn(async (input, id) => ({
      id: id || "azure-new",
      name: input.name,
      baseUrl: input.baseUrl,
      hasApiKey: Boolean(input.apiKey)
    }));
    render(
      <ProviderManager open providers={providers} selectedProviderId="openai-main"
        onClose={vi.fn()} onSelect={vi.fn()} onSave={onSave} onDelete={vi.fn()} />
    );

    await userEvent.click(screen.getByRole("button", { name: "New provider" }));
    await userEvent.type(screen.getByLabelText("Display name"), "Azure");
    await userEvent.type(screen.getByLabelText("OpenAI-compatible base URL"), "https://azure.example/v1");
    await userEvent.type(screen.getByLabelText("API key"), "azure-secret");
    await userEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(onSave).toHaveBeenLastCalledWith({
      name: "Azure",
      baseUrl: "https://azure.example/v1",
      apiKey: "azure-secret"
    }, undefined);

    await userEvent.click(screen.getByText("OpenAI main"));
    await userEvent.click(screen.getByLabelText("Remove saved API key"));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenLastCalledWith({
      name: "OpenAI main",
      baseUrl: "https://api.openai.com/v1",
      apiKey: ""
    }, "openai-main");
  });
});

