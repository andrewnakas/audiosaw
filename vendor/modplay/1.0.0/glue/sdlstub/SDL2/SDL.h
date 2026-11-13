/* pt2-clone is an SDL application and its shared headers name SDL types in
** structs the replayer never touches. These stand in for them so the
** replayer compiles without SDL. Nothing here is ever called. */
#pragma once
#include <stdint.h>
#include <stdbool.h>
typedef uint8_t Uint8; typedef int8_t Sint8;
typedef uint16_t Uint16; typedef int16_t Sint16;
typedef uint32_t Uint32; typedef int32_t Sint32;
typedef uint64_t Uint64; typedef int64_t Sint64;
typedef int32_t SDL_Scancode, SDL_Keycode;
typedef uint32_t SDL_AudioDeviceID;
typedef struct SDL_Window SDL_Window;
typedef struct SDL_Renderer SDL_Renderer;
typedef struct SDL_Texture SDL_Texture;
typedef struct SDL_Thread SDL_Thread;
typedef struct SDL_Cursor SDL_Cursor;
typedef struct SDL_Rect { int x, y, w, h; } SDL_Rect;
#define SDLCALL
