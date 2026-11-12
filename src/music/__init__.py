"""FastAPI entrypoint and local CLI"""


def main() -> None:
    import uvicorn

    uvicorn.run("music.app:app", host="127.0.0.1", port=8000, workers=1)
