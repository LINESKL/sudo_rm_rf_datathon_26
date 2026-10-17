import base64

from ml.video import low_res_stream, probe, sample_frames, to_jpeg_b64

def test_probe(tiny_video):
    dur, fps = probe(tiny_video)
    assert abs(dur - 8.0) < 0.1 and abs(fps - 30) < 0.5

def test_sample_frames_times_and_size(tiny_video):
    frames = sample_frames(tiny_video, [0.0, 1.5, 3.9])
    assert [round(t, 1) for t, _ in frames] == [0.0, 1.5, 3.9]
    assert frames[0][1].size == (464, 848)

def test_sample_frames_clips_beyond_duration(tiny_video):
    frames = sample_frames(tiny_video, [10.0])
    assert len(frames) == 1 and frames[0][0] <= 8.0

def test_low_res_stream_shape(tiny_video):
    ts, arr = low_res_stream(tiny_video, fps=4.0)
    assert arr.ndim == 3 and arr.shape[0] == len(ts) and 30 <= len(ts) <= 33

def test_jpeg_b64(tiny_video):
    _, img = sample_frames(tiny_video, [1.0])[0]
    raw = base64.b64decode(to_jpeg_b64(img))
    assert raw[:2] == b"\xff\xd8"


def test_sample_frames_uses_one_ffmpeg_pass(tiny_video, monkeypatch):
    import subprocess as sp
    import ml.video as video
    real, calls = sp.run, []

    def counting(cmd, *a, **k):
        if "ffmpeg" in str(cmd[0]):
            calls.append(cmd)
        return real(cmd, *a, **k)

    monkeypatch.setattr(video.subprocess, "run", counting)
    frames = sample_frames(tiny_video, [0.5 * i for i in range(12)])
    assert len(frames) == 12 and len(calls) == 1


def test_sample_frames_match_seek_based_grab(tiny_video):
    import numpy as np
    from ml.video import _grab
    (_, fast), = sample_frames(tiny_video, [2.0])
    slow = _grab(tiny_video, 2.0, 464)
    diff = np.abs(np.asarray(fast, dtype=int) - np.asarray(slow, dtype=int)).mean()
    assert fast.size == slow.size and diff < 3


def test_frames_carry_stable_source_id(tiny_video):
    a = sample_frames(tiny_video, [1.0])[0][1].info["src"]
    b = sample_frames(tiny_video, [1.0])[0][1].info["src"]
    c = sample_frames(tiny_video, [2.0])[0][1].info["src"]
    assert a == b and a != c
