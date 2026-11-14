"""Local streaming dictation. JSONL output; stdin 'stop' releases the microphone."""
import argparse
import json
import sys
import threading
import time
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx


def emit(**data):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--wav")
    args = parser.parse_args()
    root = Path(args.model)
    recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(root / "tokens.txt"), encoder=str(root / "encoder.int8.onnx"),
        decoder=str(root / "decoder.onnx"), joiner=str(root / "joiner.int8.onnx"),
        num_threads=2, sample_rate=16000, feature_dim=80, enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.4, rule2_min_trailing_silence=1.2,
        rule3_min_utterance_length=25, decoding_method="greedy_search",
    )
    stream = recognizer.create_stream()
    phrases = []
    previous = ""

    def consume(samples, rate=16000):
        nonlocal previous
        stream.accept_waveform(rate, samples)
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        text = recognizer.get_result(stream).strip()
        full = "，".join(phrases + ([text] if text else []))
        if full != previous:
            emit(text=full)
            previous = full
        if recognizer.is_endpoint(stream):
            if text:
                phrases.append(text)
            recognizer.reset(stream)

    if args.wav:
        with wave.open(args.wav, "rb") as source:
            if source.getnchannels() != 1 or source.getsampwidth() != 2:
                raise ValueError("Test audio must be mono PCM16")
            rate = source.getframerate()
            while chunk := source.readframes(int(rate * .1)):
                consume(np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768, rate)
    else:
        import sounddevice as sd
        stop = threading.Event()
        threading.Thread(target=lambda: (sys.stdin.readline(), stop.set()), daemon=True).start()
        with sd.InputStream(channels=1, dtype="float32", samplerate=16000, blocksize=1600) as microphone:
            emit(ready=True)
            started = time.monotonic()
            while not stop.is_set() and time.monotonic() - started < 120:
                samples, overflow = microphone.read(1600)
                if overflow:
                    emit(warning="麦克风数据有丢失，请检查输入设备。")
                consume(samples[:, 0])
    # Flush the final acoustic chunk after stopping; no audio is saved.
    consume(np.zeros(8000, dtype=np.float32))
    stream.input_finished()
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    tail = recognizer.get_result(stream).strip()
    emit(text="，".join(phrases + ([tail] if tail else [])), final=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit(error=str(error))
        sys.exit(1)
