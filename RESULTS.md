# Results

Setup: 32GB MBP M5

## HumanEval

### Qwen3.5-0.8B

- 15.2% - 1024 thinking, 2048 tokens, 3 passes, Qwen3.5-0.8B-MLX-4bit, 42m35s (16.5% if extracting code from thinking)
- 20.7% - no thinking, 1024 tokens, 3 passes, Qwen3.5-0.8B-MLX-4bit, 7m50s
- 24.4% - no thinking, 1024 tokens, 3 passes, Qwen3.5-0.8B-MLX-bf16, 23m6s
- 24.8% - 1024 thinking, 2048 tokens, 3 passes, Qwen3.5-0.8B-MLX-bf16, 1h35m (27.4% if extracting code from thinking)

Conclusions:
- 4bit no thinking is very fast and smart enough
- thinking makes 4bit worse, but improves 16bit
- 16bit thinking is the best, but slowest

### gemma-4-12B

- 97% - 8192 thinking, 16384 tokens, 1 pass, gemma-4-12B-it-8bit, 23h33m
- 96.3% - 8192 thinking, 16384 tokens, 1 pass, gemma-4-12B-it-8bit, 23h (partly using speculative decoding, hence the speedup iirc)

### gemma-4-26B-A4B

- 81.7% - 8192 thinking, 16384 tokens, 1 pass, gemma-4-26B-A4B-it-QAT-MLX-4bit, 6h50m

### gemma-4-31b

- 97.6% - unlimited thinking, 16384 tokens, 1 pass, unsloth/gemma-4-31B-it-qat-GGUF + MTP (via unsloth), 4h47m (looped similarly to MLX in 3 tasks but used up all on thinking so failed; only 116 was a genuine failure - passed 9/10 assertions) - used more RAM than MLX
- 100% - 8192 thinking, 16384 tokens, 1 pass, gemma-4-31B-it-MLX-4bit + VLM MTP gemma-4-31B-it-assistant-bf16, 5h43m

### Qwen3.6-27B

- [WIP 74/164 42.7%-97.6%] 94.6% - 8192 thinking, 16384 tokens, 1 pass, Qwen3.5-27B-Claude-4.6-Opus-Distilled-MLX-4bit, 2h17m (failed: 32 (infinite loop), 41 (comment parsed as code), 65, 68)
- 98.8% - 8192 thinking, 16384 tokens, 3 passes, Qwen3.6-27B-MXFP4, 31h28m (failed, same in all passes: 134 (didn't handle edge case correctly, pretty clearly wrong assumption), 145) (#94 failed if extracting code from thinking)
- 98.8% - 8192 thinking, 16384 tokens, 1 pass, Qwen3.6-27B-MLX-6bit, 24h8m (failed: 32 (luck-based solution), 145 (tricky requirement misinterpretation); 2nd incomplete pass: 145)

Conclusions:
- Qwen3.6-27B is a very strong model
- MXFP4 runs 2.5x faster than 6bit and fits much more comfortably on the 32GB MBP M5, same eval accuracy
- Opus-Distilled quite a bit lower accuracy than base, might be more clever on math since that is what it was distilled on for the most part
- Gemma-4-31B is very strong, barely fits tho

### Qwen3.8-27B

- 97.6% - 8192 thinking, 2048 output, 1 pass, qwen3.8-27b-uncensored-mlx + VLM MTP Qwen3.8-27B-MTP-4bit block-size 4, 13h32m (failed: 32, 47 - bad example but it followed because no refusal, 116, 145)

### gpt-oss-20b

- 96.3% - 8192 thinking, 16384 tokens, 3 passes, gpt-oss-20b-MXFP4-Q8, 2h7m (failed: 10, 103, 106, 127, 145, 147)

Conclusions:
- Surprisingly fast and strong, nothing like the old GPT-2

### Devstral-Small-2-24B-Instruct-2512

- 84.1% - thinking not supported, 16384 tokens, 1 pass, Devstral-Small-2-24B-Instruct-2512-4bit, 1h15m (failed: 10, 32, 54, 65, 74, 75, 91, 99, 102, 108, 115, 120, 121, 126, 127, 129, 130, 132, 135, 144, 145, 147, 160, 161, 163; errored: 96)

## BBEH

- [WIP 52/460 5%-93.7%] - 44.2% - 16384 thinking, 18432 tokens, 1 pass, Qwen3.6-27B-MXFP4, 18h32m, `BBEH Mini (corrected) · data 80d12ca+linguini-single-blank-v1`
- [WIP 55/460 2.2%-90.2%] - 18.2% - 8192? thinking, 16384 tokens, 1 pass, gpt-oss-20b-MXFP4-Q8, 2h15m, `BBEH Mini (official data)`
- [WIP 29/460 0%-93.7%] - 0% - 16384 thinking, 18432 tokens, 1 pass, gemma-4-12B-it-8bit + VLM MTP gemma-4-12B-it-qat-assistant-bf16 block-size 3, 8h14m, `BBEH Mini (corrected) · data 80d12ca+linguini-single-blank-v1` - looping all the time, both with default and 1.08 repetition penalty
- [WIP 23/460 2%-97%] - 39.1% - 16384 thinking, 18432 tokens, 1 pass, gemma-4-12B-it-8bit, 13h, `BBEH Mini (corrected) · data 80d12ca+linguini-single-blank-v1`
- [WIP 35/460 3%-95.4%] - 40% - 8192 thinking, 8192 output, 1 pass, qwen3.8-27b-uncensored-mlx + VLM MTP Qwen3.8-27B-MTP-4bit block-size 4, 9h46m, `BBEH Mini (corrected) · data 80d12ca+linguini-single-blank-v1`

- [WIP 62/460 8.9%-95.4%] - 66.1% - 8192 thinking, 16384 tokens, 1 pass, gemma-4-31B-it-MLX-4bit + VLM MTP gemma-4-31B-it-assistant-bf16, 9h45m, `BBEH Mini (corrected) · data 80d12ca+linguini-single-blank-v1` - was hitting token limits, increasing them might improve score

Conclusions:
- gemma-4-12B-it-8bit keeps thinking whole token budget even when forced to answer when using VLM MTP gemma-4-12B-it-qat-assistant-bf16, without it - stops thinking at limit and answers; Disabled in https://github.com/jundot/omlx/commit/9387ebddf6f62b27ac0547ca82e09fd0f418bf40
