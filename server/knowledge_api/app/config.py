from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "postgresql://panda1@localhost:5432/bambook"
    api_key: str = "change-me"
    allowed_origins: str = "*"

    ollama_base: str = "http://127.0.0.1:11434"
    embed_model: str = "nomic-embed-text"
    embed_dim: int = 768

    deepseek_base: str = "https://api.deepseek.com/v1"
    deepseek_api_key: str = ""
    deepseek_model: str = "deepseek-chat"

    rag_top_k: int = 5
    chunk_max_chars: int = 1200

    # Public URL path segment (must match Cloudflare Tunnel « Path », e.g. /bambook)
    url_mount_path: str = "/bambook"
    main_data_api_base: str = "http://127.0.0.1:8081"


settings = Settings()
