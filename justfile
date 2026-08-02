login:
    balena login --web

build:
    balena build -f home_audio --emulated

deploy:
    balena deploy home_audio

