# Local AI model conversion provenance

This record applies to the compact Qwen3-1.7B GGUF evaluation candidates sourced from
`unsloth/Qwen3-1.7B-GGUF` at commit `d7f544eead698dbd1f15126ef60b45a1e1933222`:

- `Qwen3-1.7B-IQ4_XS.gguf`, 1,010,383,424 bytes, SHA-256
  `a02e41d3208e97a7cb224297e8d3abb22e5bb8d664362c6be4f48948a3797eec`
- `Qwen3-1.7B-Q4_K_M.gguf`, 1,107,409,472 bytes, SHA-256
  `b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897`

The source repository declares `Qwen/Qwen3-1.7B` as its base model and Apache License 2.0. It does
not document the exact upstream weight revision, llama.cpp revision, conversion tool version, or
per-file conversion recipe. Métis does not infer or invent those missing facts.

Status: `review-required`. These files may be evaluated, but this notice is not release approval.
A production selection requires a separate, hashed `release-exception` record approved during the
model and release review. Without that record, release validation fails closed.
