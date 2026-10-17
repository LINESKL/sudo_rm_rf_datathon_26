"""Load the optional ML dependencies only when the real analyzer is requested."""


def __getattr__(name):
    if name == "analyze":
        from ml.pipeline import analyze
        return analyze
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
