/*
 * mt32emu_wasm.cpp: the C entry points of AudioSaw's WebAssembly build of
 * libmt32emu (Munt). Licensed like the library it wraps: LGPL-2.1-or-later.
 *
 * Why the C++ API and not the library's own c_interface: c_interface.cpp
 * links FileStream (iostream) and the default report handler prints with
 * vprintf, which together pull a filesystem and stdio into the module. ROMs
 * arrive here as memory, and nothing is ever printed, so the module needs no
 * imports that do work.
 *
 * No ROM data is compiled in. The caller supplies its own.
 */
#include <cstdlib>
#include <cstring>
#include <cstdarg>

#include "Types.h"
#include "File.h"
#include "ROMInfo.h"
#include "Synth.h"

using namespace MT32Emu;

#define API(ret) extern "C" __attribute__((used, visibility("default"))) ret

namespace {

// printDebug is the only handler that would reach stdio.
class QuietHandler : public ReportHandler {
public:
	void printDebug(const char *, va_list) {}
	void showLCDMessage(const char *) {}
};

struct Slot {
	ArrayFile *file;
	ArrayFile *file2;
	const ROMImage *image;
	Slot() : file(NULL), file2(NULL), image(NULL) {}
	void clear() {
		// An image merged from two halves owns its File and frees it itself.
		if (image != NULL) ROMImage::freeROMImage(image);
		delete file;
		delete file2;
		file = file2 = NULL;
		image = NULL;
	}
};

struct Ctx {
	QuietHandler handler;
	Synth *synth;
	Slot control;
	Slot pcm;
	Ctx() : synth(NULL) {}
};

const ROMInfo *lastInfo = NULL;
char lastSha1[41];

bool listHas(const ROMInfo * const *list, const ROMInfo *info) {
	for (; *list != NULL; list++) if (*list == info) return true;
	return false;
}

} // namespace

API(const char *) mt32_version(void) { return MT32EMU_VERSION; }

// 1 when the bytes are a known ROM (whole or one half), 0 otherwise. The
// answer is read back with the mt32_info_* calls below.
API(int) mt32_identify(const Bit8u *data, size_t size) {
	ArrayFile file(data, size);
	lastInfo = ROMInfo::getROMInfo(&file);
	if (lastInfo == NULL) return 0;
	strncpy(lastSha1, lastInfo->sha1Digest, 40);
	lastSha1[40] = 0;
	return 1;
}
API(int) mt32_info_type(void) { return lastInfo == NULL ? -1 : int(lastInfo->type); }
API(int) mt32_info_pair(void) { return lastInfo == NULL ? -1 : int(lastInfo->pairType); }
API(const char *) mt32_info_id(void) { return lastInfo == NULL ? "" : lastInfo->shortName; }
API(const char *) mt32_info_desc(void) { return lastInfo == NULL ? "" : lastInfo->description; }
API(const char *) mt32_info_sha1(void) { return lastInfo == NULL ? "" : lastSha1; }

// The list the page prints: every ROM the library knows. Index past the end
// returns 0.
API(int) mt32_known(unsigned index) {
	const ROMInfo * const *all = ROMInfo::getAllROMInfos();
	for (unsigned i = 0; all[i] != NULL; i++) {
		if (i != index) continue;
		lastInfo = all[i];
		strncpy(lastSha1, lastInfo->sha1Digest, 40);
		lastSha1[40] = 0;
		return 1;
	}
	return 0;
}

API(Ctx *) mt32_create(void) { return new Ctx(); }

/*
 * The bytes must stay where they are until mt32_close: the library keeps a
 * pointer, not a copy.
 * Returns 1 control ROM ready, 2 PCM ROM ready, 3 / 4 half of a control / PCM
 * ROM taken and waiting for the other half, -1 not a known ROM, -7 the two
 * halves do not belong together.
 */
API(int) mt32_add_rom(Ctx *ctx, const Bit8u *data, size_t size) {
	ArrayFile *file = new ArrayFile(data, size);
	const ROMImage *image = ROMImage::makeROMImage(file, ROMInfo::getAllROMInfos());
	const ROMInfo *info = image == NULL ? NULL : image->getROMInfo();
	if (info == NULL) {
		if (image != NULL) ROMImage::freeROMImage(image);
		delete file;
		return -1;
	}
	bool isControl = info->type == ROMInfo::Control;
	Slot &slot = isControl ? ctx->control : ctx->pcm;
	if (slot.file != NULL && slot.file2 == NULL) {
		// Tried for a whole file too: the 512 KB MT-32 PCM ROM is also the
		// low half of the CM-32L's, and is identified as the former.
		const ROMImage *merged = ROMImage::makeROMImage(slot.file, file);
		if (merged != NULL) {
			ROMImage::freeROMImage(image);
			ROMImage::freeROMImage(slot.image);
			slot.image = merged;
			slot.file2 = file;
			return isControl ? 1 : 2;
		}
		if (info->pairType != ROMInfo::Full && slot.image->getROMInfo()->pairType != ROMInfo::Full) {
			ROMImage::freeROMImage(image);
			delete file;
			return -7;
		}
	}
	slot.clear();
	slot.file = file;
	slot.image = image;
	if (info->pairType == ROMInfo::Full) return isControl ? 1 : 2;
	return isControl ? 3 : 4;
}

/*
 * 0 ok, -4 a ROM is missing or only half of one was given, -7 the control and
 * PCM ROMs are not from the same machine, -100 the library refused them.
 * analog: 0 digital only, 1 coarse (both 32 kHz). renderer: 0 integer (the
 * hardware's arithmetic), 1 float.
 */
API(int) mt32_open(Ctx *ctx, int analog, int renderer) {
	if (ctx->synth != NULL) return -100;
	const ROMImage *c = ctx->control.image;
	const ROMImage *p = ctx->pcm.image;
	if (c == NULL || p == NULL) return -4;
	if (c->getROMInfo()->pairType != ROMInfo::Full || p->getROMInfo()->pairType != ROMInfo::Full) return -4;

	// Synth::open does not check that the pair is one machine's: an MT-32
	// control ROM with a CM-32L PCM ROM opens and plays the wrong samples.
	const MachineConfiguration * const *machines = MachineConfiguration::getAllMachineConfigurations();
	bool paired = false;
	for (Bit32u i = 0; machines[i] != NULL && !paired; i++) {
		const ROMInfo * const *list = machines[i]->getCompatibleROMInfos();
		paired = listHas(list, c->getROMInfo()) && listHas(list, p->getROMInfo());
	}
	if (!paired) return -7;

	Synth *synth = new Synth(&ctx->handler);
	synth->selectRendererType(renderer == 1 ? RendererType_FLOAT : RendererType_BIT16S);
	AnalogOutputMode mode = analog == 0 ? AnalogOutputMode_DIGITAL_ONLY : AnalogOutputMode_COARSE;
	if (!synth->open(*c, *p, mode)) {
		delete synth;
		return -100;
	}
	// The default 1024 is for a live port; a file can hold a bank of sysex
	// at one instant.
	synth->setMIDIEventQueueSize(16384);
	ctx->synth = synth;
	return 0;
}

API(unsigned) mt32_rate(Ctx *ctx) { return ctx->synth == NULL ? 0 : ctx->synth->getStereoOutputSampleRate(); }

// Timestamps are frames rendered since open. 1 queued, 0 the queue is full
// (render some and try again), -1 not open.
API(int) mt32_play_msg(Ctx *ctx, unsigned msg, unsigned frame) {
	if (ctx->synth == NULL) return -1;
	return ctx->synth->playMsg(msg, frame) ? 1 : 0;
}
API(int) mt32_play_sysex(Ctx *ctx, const Bit8u *data, unsigned len, unsigned frame) {
	if (ctx->synth == NULL) return -1;
	return ctx->synth->playSysex(data, len, frame) ? 1 : 0;
}

// Interleaved stereo float, `frames` frames.
API(int) mt32_render(Ctx *ctx, float *out, unsigned frames) {
	if (ctx->synth == NULL) return -1;
	ctx->synth->render(out, frames);
	return 0;
}

API(int) mt32_active(Ctx *ctx) { return ctx->synth != NULL && ctx->synth->isActive() ? 1 : 0; }

API(void) mt32_close(Ctx *ctx) {
	if (ctx == NULL) return;
	if (ctx->synth != NULL) {
		ctx->synth->close();
		delete ctx->synth;
	}
	ctx->control.clear();
	ctx->pcm.clear();
	delete ctx;
}
