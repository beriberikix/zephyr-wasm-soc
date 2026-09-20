	.file	"q2_data.c"
	.hidden	__k_thread_t_a_OFFSET           # @__k_thread_t_a_OFFSET
	.type	__k_thread_t_a_OFFSET,@object
	.section	z_offsets,"R",@
	.globl	__k_thread_t_a_OFFSET
	.p2align	2, 0x0
__k_thread_t_a_OFFSET:
	.int32	0                               # 0x0
	.size	__k_thread_t_a_OFFSET, 4

	.hidden	__k_thread_t_b_OFFSET           # @__k_thread_t_b_OFFSET
	.type	__k_thread_t_b_OFFSET,@object
	.globl	__k_thread_t_b_OFFSET
	.p2align	2, 0x0
__k_thread_t_b_OFFSET:
	.int32	4                               # 0x4
	.size	__k_thread_t_b_OFFSET, 4

	.hidden	__k_thread_t_c_OFFSET           # @__k_thread_t_c_OFFSET
	.type	__k_thread_t_c_OFFSET,@object
	.globl	__k_thread_t_c_OFFSET
	.p2align	2, 0x0
__k_thread_t_c_OFFSET:
	.int32	8                               # 0x8
	.size	__k_thread_t_c_OFFSET, 4

	.hidden	__k_thread_t_d_OFFSET           # @__k_thread_t_d_OFFSET
	.type	__k_thread_t_d_OFFSET,@object
	.globl	__k_thread_t_d_OFFSET
	.p2align	2, 0x0
__k_thread_t_d_OFFSET:
	.int32	16                              # 0x10
	.size	__k_thread_t_d_OFFSET, 4

	.hidden	__k_thread_t_SIZEOF             # @__k_thread_t_SIZEOF
	.type	__k_thread_t_SIZEOF,@object
	.globl	__k_thread_t_SIZEOF
	.p2align	2, 0x0
__k_thread_t_SIZEOF:
	.int32	24                              # 0x18
	.size	__k_thread_t_SIZEOF, 4

	.hidden	__struct_arch_esf_sp_OFFSET     # @__struct_arch_esf_sp_OFFSET
	.type	__struct_arch_esf_sp_OFFSET,@object
	.globl	__struct_arch_esf_sp_OFFSET
	.p2align	2, 0x0
__struct_arch_esf_sp_OFFSET:
	.int32	4                               # 0x4
	.size	__struct_arch_esf_sp_OFFSET, 4

	.no_dead_strip	__k_thread_t_SIZEOF
	.no_dead_strip	__k_thread_t_a_OFFSET
	.no_dead_strip	__k_thread_t_b_OFFSET
	.no_dead_strip	__k_thread_t_c_OFFSET
	.no_dead_strip	__k_thread_t_d_OFFSET
	.no_dead_strip	__struct_arch_esf_sp_OFFSET
	.ident	"Homebrew clang version 23.1.1"
	.section	.custom_section.producers,"",@
	.int8	1
	.int8	12
	.ascii	"processed-by"
	.int8	1
	.int8	14
	.ascii	"Homebrew clang"
	.int8	6
	.ascii	"23.1.1"
	.section	z_offsets,"R",@
	.section	.custom_section.target_features,"",@
	.int8	8
	.int8	43
	.int8	11
	.ascii	"bulk-memory"
	.int8	43
	.int8	15
	.ascii	"bulk-memory-opt"
	.int8	43
	.int8	22
	.ascii	"call-indirect-overlong"
	.int8	43
	.int8	10
	.ascii	"multivalue"
	.int8	43
	.int8	15
	.ascii	"mutable-globals"
	.int8	43
	.int8	19
	.ascii	"nontrapping-fptoint"
	.int8	43
	.int8	15
	.ascii	"reference-types"
	.int8	43
	.int8	8
	.ascii	"sign-ext"
	.section	z_offsets,"R",@
