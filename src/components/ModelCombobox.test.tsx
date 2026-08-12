import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCombobox } from "./ModelCombobox";

afterEach(cleanup);

const MODELS = [
  "Qwen3.5-9B-OptiQ-4bit",
  "Qwen3.5-0.8B-MLX-4bit",
  "gemma-4-12B-it-8bit",
  "gpt-oss-20b-MXFP4-Q8"
];

function Harness({
  models = MODELS,
  loading = false,
  onOpen = () => {}
}: {
  models?: string[];
  loading?: boolean;
  onOpen?: () => void;
}) {
  const [value, setValue] = useState("");
  return <ModelCombobox models={models} loading={loading} value={value} onChange={setValue} onOpen={onOpen} />;
}

describe("ModelCombobox", () => {
  it("opens the full list on focus and reports the open to the refresher", async () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("option")).toHaveLength(MODELS.length);
  });

  it("filters with space-separated terms and selects on click", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "qwen 9b");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.pointerDown(screen.getByText("Qwen3.5-9B-OptiQ-4bit"));
    expect(input).toHaveValue("Qwen3.5-9B-OptiQ-4bit");
    // A selected value shows the whole list again so switching stays easy.
    await userEvent.click(input);
    expect(screen.getAllByRole("option")).toHaveLength(MODELS.length);
  });

  it("selects with arrow keys and enter", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    await userEvent.click(input);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(input).toHaveValue(MODELS[1]);
  });

  it("keeps free text working when the endpoint lists nothing", async () => {
    render(<Harness models={[]} />);
    const input = screen.getByRole("combobox");
    await userEvent.type(input, "my-custom-model");
    expect(input).toHaveValue("my-custom-model");
    expect(screen.getByText(/endpoint unreachable/i)).toBeInTheDocument();
  });

  it("shows loading instead of stale suggestions while a provider changes", async () => {
    render(<Harness loading />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Loading models…")).toBeInTheDocument();
  });
});
